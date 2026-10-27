import { common } from '@kit.AbilityKit';
import { SEGMENT_KINDS, SegmentOutput, TextSegment, TranslationRequest, TranslationOutput,
  PreprocessTrace, TranslationInput, TranslationAnalysis } from '../model/TranslationModels';
import { PreprocessEngine, TranslationEnginePolicy, TranslationEngine, DiagnosticEventHandler,
  PartialResultHandler, translateWithPartialResults } from './TranslationProtocols';
import { FixedTranslationEnginePolicy, IOSAdaptiveTranslationEnginePolicy } from './EnginePolicies';
import { FoundationModelsTranslationEngine, TranslationFrameworkPrimaryTranslationEngine,
  TranslationCancelledError } from './TranslationEngines';

export type SessionStartedHandler = (segmentCount: number, tokenizerSentenceCount: number,
  detectedLanguageCode: string, targetLanguage: string, kindSummary: string) => void;
export type PartialSegmentResultHandler = (segmentIndex: number, partialTranslation: string,
  joinersAfter: string[]) => void;
export type SessionFinishedHandler = () => void;

export class TranslationPipelineError extends Error {
  readonly detectedLanguageCode: string;

  constructor(detectedLanguageCode: string) {
    super(`${detectedLanguageCode} is not supported by Apple Intelligence`);
    this.name = 'TranslationPipelineError';
    this.detectedLanguageCode = detectedLanguageCode;
  }

  get errorDescription(): string {
    return this.message;
  }
}

class LogicalTranslationTask {
  cancelled: boolean = false;
  sessionStarted: boolean = false;
  engine?: TranslationEngine;
  reject?: (error: Error) => void;
  completion?: Promise<TranslationOutput>;
}

export class TranslationOrchestrator {
  readonly preprocessEngine: PreprocessEngine;
  readonly enginePolicy: TranslationEnginePolicy;
  private readonly activeTasks: Set<LogicalTranslationTask> = new Set<LogicalTranslationTask>();

  constructor(preprocessEngine: PreprocessEngine, enginePolicy: TranslationEnginePolicy) {
    this.preprocessEngine = preprocessEngine;
    this.enginePolicy = enginePolicy;
  }

  initialize(context: common.Context): void {
    if (this.enginePolicy instanceof IOSAdaptiveTranslationEnginePolicy ||
      this.enginePolicy instanceof FixedTranslationEnginePolicy) {
      this.enginePolicy.initialize(context);
    }
  }

  cancelTranslation(): void {
    for (const task of this.activeTasks) {
      task.cancelled = true;
      task.reject?.(new TranslationCancelledError());
      if (task.engine instanceof FoundationModelsTranslationEngine ||
        task.engine instanceof TranslationFrameworkPrimaryTranslationEngine) {
        task.engine.cancelTranslation();
      }
    }
  }

  async drainPendingTranslation(): Promise<void> {
    // Native drain may never finish; UI task ownership waits only for logical settlement.
    const pending = Array.from(this.activeTasks);
    for (const task of pending) {
      try {
        await task.completion;
      } catch (_error) {
        continue;
      }
    }
  }

  async translate(request: TranslationRequest, onSessionStarted?: SessionStartedHandler,
    onDiagnosticEvent?: DiagnosticEventHandler, onPartialSegmentResult?: PartialSegmentResultHandler,
    onSessionFinished?: SessionFinishedHandler): Promise<TranslationOutput> {
    const task = new LogicalTranslationTask();
    this.activeTasks.add(task);
    const cancelled = new Promise<TranslationOutput>((_resolve: (output: TranslationOutput) => void,
      reject: (error: Error) => void) => {
      task.reject = reject;
    });
    try {
      task.completion = Promise.race([this.performTranslation(task, request, onSessionStarted,
        onDiagnosticEvent, onPartialSegmentResult), cancelled]);
      return await task.completion;
    } finally {
      task.cancelled = true;
      task.reject = undefined;
      this.activeTasks.delete(task);
      if (task.sessionStarted) {
        onSessionFinished?.();
      }
    }
  }

  private async performTranslation(task: LogicalTranslationTask, request: TranslationRequest,
    onSessionStarted?: SessionStartedHandler, onDiagnosticEvent?: DiagnosticEventHandler,
    onPartialSegmentResult?: PartialSegmentResultHandler): Promise<TranslationOutput> {
    const preprocessResult = this.preprocessEngine.analyze(request);
    const input = preprocessResult.input;
    const effectiveSourceLanguage = input.detectedLanguageCode ?? input.sourceLanguage;
    const diagnostic: DiagnosticEventHandler = (message: string): void => {
      if (!task.cancelled) {
        onDiagnosticEvent?.(message);
      }
    };
    const partial: PartialResultHandler = (index: number, text: string): void => {
      if (!task.cancelled) {
        onPartialSegmentResult?.(index, text, input.segmentJoinersAfter);
      }
    };
    if (this.isSameLanguagePair(effectiveSourceLanguage, input.targetLanguage)) {
      diagnostic(`engine=fallback-same-language source=${effectiveSourceLanguage} target=${input.targetLanguage}`);
      const segments = input.segments.length === 0 ? [new TextSegment(0, input.originalText)] : input.segments;
      const segmentOutputs = segments.map((segment: TextSegment): SegmentOutput =>
        new SegmentOutput(segment.index, segment.text, segment.text, true, false));
      for (const output of segmentOutputs) {
        partial(output.segmentIndex, output.translatedText);
      }
      if (task.cancelled) {
        throw new TranslationCancelledError();
      }
      const traces = preprocessResult.traces.concat([new PreprocessTrace('same-language-fallback',
        `source=${effectiveSourceLanguage}, target=${input.targetLanguage}`)]);
      return this.output(request, input, traces, 'same-language-fallback', segmentOutputs, input.originalText);
    }
    const engine = this.enginePolicy.resolveEngine(request);
    task.engine = engine;
    if (engine.name.includes('foundation-models') && !input.isDetectedLanguageSupportedByAppleIntelligence &&
      input.detectedLanguageCode !== undefined) {
      throw new TranslationPipelineError(input.detectedLanguageCode);
    }
    task.sessionStarted = true;
    onSessionStarted?.(input.segments.length, this.sentenceCountByNLTokenizer(input.originalText),
      input.detectedLanguageCode ?? input.sourceLanguage, request.targetLanguage, this.summarizeKinds(input.segments));
    if (task.cancelled) {
      throw new TranslationCancelledError();
    }
    let segmentOutputs: SegmentOutput[];
    if (engine instanceof FoundationModelsTranslationEngine ||
      engine instanceof TranslationFrameworkPrimaryTranslationEngine) {
      segmentOutputs = await engine.translate(input, partial, diagnostic);
    } else {
      segmentOutputs = await translateWithPartialResults(engine, input, partial);
    }
    if (task.cancelled) {
      throw new TranslationCancelledError();
    }
    segmentOutputs.sort((a: SegmentOutput, b: SegmentOutput): number => a.segmentIndex - b.segmentIndex);
    const translations = new Map<number, string>();
    for (const segment of segmentOutputs) {
      if (translations.has(segment.segmentIndex)) {
        throw new Error(`Duplicate translation segment index: ${segment.segmentIndex}`);
      }
      translations.set(segment.segmentIndex, segment.translatedText);
    }
    return this.output(request, input, preprocessResult.traces, engine.name, segmentOutputs,
      this.reconstructTranslatedText(translations, input.segmentJoinersAfter));
  }

  private output(request: TranslationRequest, input: TranslationInput, traces: PreprocessTrace[], engineName: string,
    segmentOutputs: SegmentOutput[], translatedText: string): TranslationOutput {
    const analysis: TranslationAnalysis = { request: request, traces: traces, input: input, engineName: engineName };
    const output: TranslationOutput = { translatedText: translatedText,
      containsUnsafeFallback: segmentOutputs.some((segment: SegmentOutput): boolean => segment.isUnsafeFallback),
      segmentOutputs: segmentOutputs, analysis: analysis };
    return output;
  }

  private reconstructTranslatedText(segmentTranslationsByIndex: Map<number, string>, joinersAfter: string[]): string {
    const indices = Array.from(segmentTranslationsByIndex.keys()).sort((a: number, b: number): number => a - b);
    const translations = indices.map((index: number): string => segmentTranslationsByIndex.get(index) ?? '');
    if (joinersAfter.length >= translations.length) {
      return translations.map((text: string, index: number): string =>
        text + this.normalizedJoiner(joinersAfter[index], text)).join('');
    }
    return translations.join(' ');
  }

  private normalizedJoiner(joiner: string, translatedText: string): string {
    if (/[.!?。！？]$/u.test(translatedText.replace(/[\p{White_Space}\u0085]+$/u, ''))) {
      return joiner.replace(/^(?:[.!?。！？](?![\p{M}\u200d\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]))+/u, '');
    }
    return joiner;
  }

  private summarizeKinds(segments: TextSegment[]): string {
    if (segments.length === 0) {
      return '(none)';
    }
    return SEGMENT_KINDS.map((kind): string => {
      const count = segments.filter((segment: TextSegment): boolean => segment.kind === kind).length;
      return count === 0 ? '' : `${kind}=${count}`;
    }).filter((summary: string): boolean => summary.length > 0).join(', ');
  }

  private sentenceCountByNLTokenizer(text: string): number {
    const trimmed = text.replace(/^[\p{White_Space}\u0085]+|[\p{White_Space}\u0085]+$/gu, '');
    if (trimmed.length === 0) {
      return 0;
    }
    // shortcut: punctuation sentence count approximates NLTokenizer, replace after target tokenizer parity vectors.
    const sentences = trimmed.match(/[^.!?。！？\r\n]+(?:[.!?。！？]+|[\r\n]+|$)/gu) ?? [];
    return Math.max(1, sentences.filter((sentence: string): boolean => /\P{White_Space}/u.test(sentence)).length);
  }

  private isSameLanguagePair(sourceLanguage: string, targetLanguage: string): boolean {
    const source = this.normalizedLanguageIdentifier(sourceLanguage);
    const target = this.normalizedLanguageIdentifier(targetLanguage);
    return source.length > 0 && target.length > 0 && source !== 'und' && target !== 'und' && source === target;
  }

  private normalizedLanguageIdentifier(code: string): string {
    return code.replace(/^[\p{White_Space}\u0085]+|[\p{White_Space}\u0085]+$/gu, '').toLowerCase().replace(/_/g, '-');
  }
}
