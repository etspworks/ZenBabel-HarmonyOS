import { TranslationRequest, TranslationInput, PreprocessTrace, SegmentOutput } from '../model/TranslationModels';

export interface PreprocessResult {
  input: TranslationInput;
  traces: PreprocessTrace[];
}

export interface PreprocessEngine {
  readonly name: string;
  analyze(request: TranslationRequest): PreprocessResult;
}

export type PartialResultHandler = (segmentIndex: number, partialTranslation: string) => void;
export type DiagnosticEventHandler = (message: string) => void;

export interface TranslationEngine {
  readonly name: string;
  translate(input: TranslationInput, onPartialResult?: PartialResultHandler): Promise<SegmentOutput[]>;
}

export interface DiagnosticCapableTranslationEngine extends TranslationEngine {
  translate(input: TranslationInput, onPartialResult?: PartialResultHandler,
    onDiagnosticEvent?: DiagnosticEventHandler): Promise<SegmentOutput[]>;
}

export interface TranslationEnginePolicy {
  resolveEngine(request: TranslationRequest): TranslationEngine;
}

export interface UnsafeSegmentRecoveryEngine {
  recoverUnsafeTranslation(sourceText: string, sourceLanguage: string, targetLanguage: string,
    onDiagnosticEvent?: DiagnosticEventHandler): Promise<string | undefined>;
}

// Swift's default protocol implementation emits final results when an engine has no streaming implementation.
export async function translateWithPartialResults(engine: TranslationEngine, input: TranslationInput,
  onPartialResult?: PartialResultHandler): Promise<SegmentOutput[]> {
  const outputs: SegmentOutput[] = await engine.translate(input);
  for (const output of outputs) {
    onPartialResult?.(output.segmentIndex, output.translatedText);
  }
  return outputs;
}
