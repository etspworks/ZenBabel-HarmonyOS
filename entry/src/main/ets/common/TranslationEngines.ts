import { localChatModel } from '@kit.DataAugmentationKit';
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { SegmentOutput, TextSegment, TranslationInput, SegmentKind, SegmentRole,
  StructuredTranslationPayload, StructuredTranslationResult, Waiter } from '../model/TranslationModels';
import { DiagnosticCapableTranslationEngine, PartialResultHandler, DiagnosticEventHandler,
  UnsafeSegmentRecoveryEngine } from './TranslationProtocols';
import { TranslationFrameworkUnsafeRecoveryController } from './UnsafeRecovery';

export class TranslationCancelledError extends Error {
  constructor() { super('Translation was cancelled.'); this.name = 'CancellationError'; }
}

export class TranslationPlatformUnavailableError extends Error {
  constructor(reason: string) { super(`Translation is not available on this platform: ${reason}`); }
}

export enum RecoveryFailureKind {
  MISSING_SOURCE_LANGUAGE = 'missing_source_language',
  MISSING_TARGET_LANGUAGE = 'missing_target_language',
  MISSING_SOURCE_AND_TARGET_LANGUAGE = 'missing_source_and_target_language',
  UNSUPPORTED_LANGUAGE_PAIRING = 'unsupported_language_pairing',
  PLATFORM_UNAVAILABLE = 'platform_unavailable'
}

interface RecoverySnapshot {
  failureKind?: RecoveryFailureKind;
  insertedSourceFallback: boolean;
}

class RecoveryDiagnosticState {
  private failureKind?: RecoveryFailureKind;
  private insertedSourceFallback: boolean = false;
  capture(message: string): void {
    const parsed = TranslationFrameworkPrimaryTranslationEngine.parseRecoveryFailureKind(message);
    if (parsed !== undefined) this.failureKind = parsed;
    if (message.includes('translation-framework-recovery:source-fallback-inserted')) this.insertedSourceFallback = true;
  }
  snapshot(): RecoverySnapshot {
    const value: RecoverySnapshot = { failureKind: this.failureKind, insertedSourceFallback: this.insertedSourceFallback };
    return value;
  }
}

class TranslationCancellation {
  readonly id: string = util.generateRandomUUID();
  cancelled: boolean = false;
  onCancel?: () => void;
  nativeWork: Promise<void>[] = [];
  cancel(): void { this.cancelled = true; this.onCancel?.(); }
  check(): void { if (this.cancelled) throw new TranslationCancelledError(); }
  waitFor<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.onCancel = () => reject(new TranslationCancelledError());
      work.then((value: T) => { this.onCancel = undefined; if (this.cancelled) reject(new TranslationCancelledError()); else resolve(value); },
        (error: Error) => { this.onCancel = undefined; reject(error); });
      if (this.cancelled) this.onCancel();
    });
  }
}

export class TranslationFrameworkPrimaryTranslationEngine implements DiagnosticCapableTranslationEngine {
  readonly name: string = 'translation-framework-primary';
  private recoveryEngine: UnsafeSegmentRecoveryEngine;
  private settings?: preferences.Preferences;
  private active: Set<TranslationCancellation> = new Set<TranslationCancellation>();

  constructor(recoveryEngine: UnsafeSegmentRecoveryEngine) { this.recoveryEngine = recoveryEngine; }
  initialize(context: common.Context): void {
    const options: preferences.Options = { name: 'zenBabel' };
    this.settings = preferences.getPreferencesSync(context, options);
    if (this.recoveryEngine instanceof TranslationFrameworkUnsafeRecoveryController) this.recoveryEngine.initialize(context);
  }
  private get verboseLoggingEnabled(): boolean {
    return this.settings?.getSync('developerVerboseModeEnabled', false) === true;
  }
  cancelTranslation(): void {
    for (const token of this.active) token.cancel();
    if (this.recoveryEngine instanceof TranslationFrameworkUnsafeRecoveryController) this.recoveryEngine.clearPendingRecoveryState();
  }
  async drainPendingTranslation(): Promise<void> {
    if (this.recoveryEngine instanceof TranslationFrameworkUnsafeRecoveryController) await this.recoveryEngine.drainPendingRecovery();
  }
  async translate(input: TranslationInput, onPartialResult?: PartialResultHandler,
    onDiagnosticEvent?: DiagnosticEventHandler): Promise<SegmentOutput[]> {
    const token = new TranslationCancellation();
    this.active.add(token);
    const segments = input.segments.length === 0 ? [new TextSegment(0, input.originalText)] : input.segments;
    const outputs: SegmentOutput[] = [];
    onDiagnosticEvent?.(`engine=tf-primary-start segments=${segments.length} source=${input.sourceLanguage} target=${input.targetLanguage}`);
    try {
      for (const segment of segments) {
        token.check();
        if (this.verboseLoggingEnabled) onDiagnosticEvent?.(`verbose tf-input segment=${segment.index} chars=${segment.text.length} source=${TranslationFrameworkPrimaryTranslationEngine.sanitizedForLog(segment.text) ?? '(empty)'}`);
        const initialState = new RecoveryDiagnosticState();
        let state = initialState;
        let translated = await token.waitFor(this.recoveryEngine.recoverUnsafeTranslation(segment.text, input.sourceLanguage,
          input.targetLanguage, (message: string) => { if (!token.cancelled) { initialState.capture(message); onDiagnosticEvent?.(message); } }));
        token.check();
        if ((translated ?? '').trim().length === 0 && state.snapshot().failureKind === RecoveryFailureKind.UNSUPPORTED_LANGUAGE_PAIRING) {
          onDiagnosticEvent?.(`segment=${segment.index}: tf-primary-retry-with-auto-source-after-unsupported-pairing`);
          const retryState = new RecoveryDiagnosticState();
          state = retryState;
          translated = await token.waitFor(this.recoveryEngine.recoverUnsafeTranslation(segment.text, 'und', input.targetLanguage,
            (message: string) => { if (!token.cancelled) { retryState.capture(message); onDiagnosticEvent?.(message); } }));
          token.check();
        }
        const snapshot = state.snapshot();
        if ((translated ?? '').trim().length === 0) {
          // As iOS (TranslationFrameworkPrimaryTranslationEngine.swift:134-150): keep the segment's source text,
          // marked as a fallback, instead of failing the whole translation.
          const reason = snapshot.failureKind ?? 'unknown';
          onDiagnosticEvent?.(`segment=${segment.index}: tf-primary-empty-result-fallback-to-source reason=${reason}`);
          onPartialResult?.(segment.index, segment.text);
          outputs.push(new SegmentOutput(segment.index, segment.text, segment.text, true, false));
          continue;
        }
        const result = translated as string;
        if (this.verboseLoggingEnabled) onDiagnosticEvent?.(`verbose tf-output segment=${segment.index} chars=${result.length} output=${TranslationFrameworkPrimaryTranslationEngine.sanitizedForLog(result)}`);
        onPartialResult?.(segment.index, result);
        outputs.push(new SegmentOutput(segment.index, segment.text, result, snapshot.insertedSourceFallback, false));
      }
      onDiagnosticEvent?.(`engine=tf-primary-finished segments=${outputs.length}`);
      return outputs;
    } finally { this.active.delete(token); }
  }
  static parseRecoveryFailureKind(message: string): RecoveryFailureKind | undefined {
    const marker = 'translation-framework-recovery:failure-kind=';
    const index = message.indexOf(marker);
    if (index < 0) return undefined;
    const raw = message.slice(index + marker.length).trim();
    const kinds: RecoveryFailureKind[] = [RecoveryFailureKind.MISSING_SOURCE_LANGUAGE,
      RecoveryFailureKind.MISSING_TARGET_LANGUAGE, RecoveryFailureKind.MISSING_SOURCE_AND_TARGET_LANGUAGE,
      RecoveryFailureKind.UNSUPPORTED_LANGUAGE_PAIRING, RecoveryFailureKind.PLATFORM_UNAVAILABLE];
    return kinds.find((kind: RecoveryFailureKind) => kind === raw);
  }
  static sanitizedForLog(text?: string): string | undefined {
    return FoundationModelsRuntimeTranslator.sanitizedForLog(text?.replace(/\r/g, '\\r'));
  }
}

class FoundationModelsTranslationGate {
  private isLocked: boolean = false;
  private waiters: Waiter[] = [];
  async withLock<T>(token: TranslationCancellation, operation: () => Promise<T>): Promise<T> {
    token.check();
    await this.acquire(token);
    try { token.check(); return await operation(); }
    finally {
      token.onCancel = undefined;
      // The SDK has no cancel API; retain the permit until isFinished AND dispatch settlement.
      Promise.all(token.nativeWork).then(() => this.release(), () => this.release());
    }
  }
  private acquire(token: TranslationCancellation): Promise<void> {
    if (!this.isLocked) { this.isLocked = true; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.cancelWaiter(token.id,
        new Error('The on-device model is still busy after Stop or timeout. Retry after native generation completes.')), 25000);
      const waiter: Waiter = { id: token.id, continuation: {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); }
      } };
      this.waiters.push(waiter);
      token.onCancel = () => this.cancelWaiter(token.id);
      if (token.cancelled) this.cancelWaiter(token.id);
    });
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next === undefined) this.isLocked = false;
    else next.continuation.resolve();
  }
  private cancelWaiter(id: string, error: Error = new TranslationCancelledError()): void {
    const index = this.waiters.findIndex((waiter: Waiter) => waiter.id === id);
    if (index >= 0) this.waiters.splice(index, 1)[0].continuation.reject(error);
  }
}

enum RuntimeErrorKind {
  UNAVAILABLE = 'unavailable',
  SEGMENT_PROCESSING_TIMEOUT = 'segmentProcessingTimeout',
  SUSPECTED_STREAM_REPETITION = 'suspectedStreamRepetition',
  STRUCTURED_OUTPUT_TARGET_MISMATCH = 'structuredOutputTargetMismatch',
  INVALID_FORMAT = 'invalidFormat',
  EMPTY_TRANSLATION = 'emptyTranslation',
  PLACEHOLDER_TRANSLATION = 'placeholderTranslation'
}

class FoundationModelsRuntimeError extends Error {
  kind: RuntimeErrorKind;
  timeoutMs: number;
  expected: string;
  actual: string;
  mode: string;
  sourceWords: number;
  outputWords: number;
  chunks: number;
  constructor(kind: RuntimeErrorKind, detail: string, timeoutMs: number = 0, expected: string = '',
    actual: string = '', mode: string = '', sourceWords: number = 0, outputWords: number = 0, chunks: number = 0) {
    super(detail); this.kind = kind; this.timeoutMs = timeoutMs; this.expected = expected; this.actual = actual;
    this.mode = mode; this.sourceWords = sourceWords; this.outputWords = outputWords; this.chunks = chunks;
  }
}

class StreamChunkProgress {
  private lastChunkAt: number = Date.now();
  didTimeout: boolean = false;
  bump(): void { this.lastChunkAt = Date.now(); }
  elapsedSinceLastChunkMs(): number { return Date.now() - this.lastChunkAt; }
  markTimedOut(): void { this.didTimeout = true; }
}

interface TranslationSession {
  instructions: string;
}
interface RepetitionDetails {
  sourceWords: number; outputWords: number; chunks: number; mode: string;
}
interface TargetMismatchDetails { expected: string; actual: string; }
interface RecoveredTranslation { translation: string; usedTranslationFrameworkRecovery: boolean; }
interface ModelFailure extends Error {
  cause?: ModelFailure;
  errors?: ModelFailure[];
  domain?: string;
  code?: number;
  failureReason?: string;
  recoverySuggestion?: string;
}
enum ChineseScriptPreference { TRADITIONAL = 'traditional', SIMPLIFIED = 'simplified' }

export class FoundationModelsTranslationEngine implements DiagnosticCapableTranslationEngine {
  readonly name: string = 'foundation-models';
  private unsafeSegmentRecoveryEngine: UnsafeSegmentRecoveryEngine;
  private settings?: preferences.Preferences;
  private active: Set<TranslationCancellation> = new Set<TranslationCancellation>();
  private nativeWork: Promise<void>[] = [];
  private translations: Set<Promise<SegmentOutput[]>> = new Set<Promise<SegmentOutput[]>>();
  isAvailable: boolean = false;
  availabilityError?: string;

  constructor(unsafeSegmentRecoveryEngine: UnsafeSegmentRecoveryEngine = new TranslationFrameworkUnsafeRecoveryController()) {
    this.unsafeSegmentRecoveryEngine = unsafeSegmentRecoveryEngine;
  }
  initialize(context: common.Context): void {
    const options: preferences.Options = { name: 'zenBabel' };
    this.settings = preferences.getPreferencesSync(context, options);
    if (this.unsafeSegmentRecoveryEngine instanceof TranslationFrameworkUnsafeRecoveryController) this.unsafeSegmentRecoveryEngine.initialize(context);
  }
  async checkAvailability(): Promise<boolean> {
    try { await FoundationModelsRuntimeTranslator.ensureModelAvailability(); this.isAvailable = true; this.availabilityError = undefined; }
    catch (error) { this.isAvailable = false; this.availabilityError = (error as Error).message; }
    return this.isAvailable;
  }
  cancelTranslation(): void {
    for (const token of this.active) token.cancel();
    if (this.unsafeSegmentRecoveryEngine instanceof TranslationFrameworkUnsafeRecoveryController) this.unsafeSegmentRecoveryEngine.clearPendingRecoveryState();
  }
  async drainPendingTranslation(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const translation of this.translations) pending.push(translation.then(() => {}, () => {}));
    await Promise.all(pending);
    await Promise.all(this.nativeWork);
    if (this.unsafeSegmentRecoveryEngine instanceof TranslationFrameworkUnsafeRecoveryController) await this.unsafeSegmentRecoveryEngine.drainPendingRecovery();
  }
  async translate(input: TranslationInput, onPartialResult?: PartialResultHandler,
    onDiagnosticEvent?: DiagnosticEventHandler): Promise<SegmentOutput[]> {
    const token = new TranslationCancellation();
    this.active.add(token);
    const translation = FoundationModelsRuntimeTranslator.translate(input, this.unsafeSegmentRecoveryEngine, token,
      () => this.settings?.getSync('developerVerboseModeEnabled', false) === true,
      onPartialResult, onDiagnosticEvent);
    this.translations.add(translation);
    try {
      return await translation;
    } finally {
      this.active.delete(token);
      this.translations.delete(translation);
      for (const work of token.nativeWork) {
        this.nativeWork.push(work);
        work.then(() => { const index = this.nativeWork.indexOf(work); if (index >= 0) this.nativeWork.splice(index, 1); });
      }
    }
  }
}

class FoundationModelsRuntimeTranslator {
  private static readonly LINE_BREAK_MARKER: string = '</br>';
  private static readonly TRANSLATION_GATE: FoundationModelsTranslationGate = new FoundationModelsTranslationGate();
  private static readonly MAX_SEGMENTS_PER_SESSION: number = 6;
  private static readonly MAX_ESTIMATED_CONTEXT_COST_PER_SESSION: number = 12000;
  private static readonly LARGE_PROMPT_CHARS_THRESHOLD: number = 2200;
  private static readonly SEGMENT_WORD_TIMEOUT_SAFETY_FACTOR: number = 1.5;
  private static readonly MINIMUM_SEGMENT_TIMEOUT_MS: number = 3000;
  private static readonly STREAM_CHUNK_STALL_TIMEOUT_MS: number = 5000;
  private static readonly REPETITION_GUARD_MIN_CHUNK_COUNT: number = 10;
  private static readonly REPETITION_GUARD_OUTPUT_WORD_MULTIPLIER: number = 3;
  private static readonly SEMANTIC_REPETITION_LOOKBACK_CHUNKS: number = 3;
  private static readonly SEMANTIC_REPETITION_MIN_SIGNATURE_LENGTH: number = 12;
  private static readonly NON_WORD_EXPLOSION_LOOKBACK_CHUNKS: number = 3;
  private static readonly NON_WORD_EXPLOSION_MIN_ADDED_CHARS: number = 24;
  private static readonly MONO_CHAR_EXPLOSION_LOOKBACK_CHUNKS: number = 2;
  private static readonly MONO_CHAR_EXPLOSION_MIN_ADDED_CHARS: number = 24;
  private static questionId: number = 0;
  private static modelReady: boolean = false;
  private static initializing?: Promise<void>;
  private static nativeChatActive: boolean = false;

  static async ensureModelAvailability(token?: TranslationCancellation): Promise<void> {
    if (FoundationModelsRuntimeTranslator.modelReady) return;
    if (FoundationModelsRuntimeTranslator.initializing === undefined) {
      const init = localChatModel.init().then((ready: boolean) => {
        if (!ready) throw new FoundationModelsRuntimeError(RuntimeErrorKind.UNAVAILABLE,
          'The on-device model is unavailable. Check device support and downloaded model assets, then retry.');
        FoundationModelsRuntimeTranslator.modelReady = true;
      });
      FoundationModelsRuntimeTranslator.initializing = init;
      init.then(() => { if (FoundationModelsRuntimeTranslator.initializing === init) FoundationModelsRuntimeTranslator.initializing = undefined; },
        () => { if (FoundationModelsRuntimeTranslator.initializing === init) FoundationModelsRuntimeTranslator.initializing = undefined; });
    }
    const work = FoundationModelsRuntimeTranslator.initializing;
    if (token !== undefined) token.nativeWork.push(work.then(() => {}, () => {}));
    const bounded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new FoundationModelsRuntimeError(RuntimeErrorKind.UNAVAILABLE,
        'On-device model initialization timed out. Native initialization may still be active. Retry after it completes.')), 25000);
      work.then(() => { clearTimeout(timer); resolve(); }, (error: Error) => { clearTimeout(timer); reject(error); });
    });
    if (token !== undefined) await token.waitFor(bounded); else await bounded;
  }
  static async translate(input: TranslationInput, recovery: UnsafeSegmentRecoveryEngine,
    token: TranslationCancellation, verboseLoggingEnabled: () => boolean, onPartialResult?: PartialResultHandler,
    onDiagnosticEvent?: DiagnosticEventHandler): Promise<SegmentOutput[]> {
    return FoundationModelsRuntimeTranslator.TRANSLATION_GATE.withLock(token, async () => {
      await FoundationModelsRuntimeTranslator.ensureModelAvailability(token);
      token.check();
      onDiagnosticEvent?.('session-model: localChatModel on-device; proprietary guardrail/session equivalence unverified');
      const segments = input.segments.length === 0 ? [new TextSegment(0, input.originalText)] : input.segments;
      let session = FoundationModelsRuntimeTranslator.makeTranslationSession(input);
      let sessionSegmentCount = 0;
      let sessionEstimatedContextCost = 0;
      let firstSegmentMsPerWord: number | undefined;
      const outputs: SegmentOutput[] = [];
      for (const segment of segments) {
        token.check();
        const started = Date.now();
        const prompt = FoundationModelsRuntimeTranslator.promptForSegment(segment, input);
        if (FoundationModelsRuntimeTranslator.shouldRefreshSessionProactively(sessionSegmentCount, sessionEstimatedContextCost, prompt.length)) {
          session = FoundationModelsRuntimeTranslator.makeTranslationSession(input); sessionSegmentCount = 0; sessionEstimatedContextCost = 0;
          onDiagnosticEvent?.(`segment=${segment.index}: proactive-session-refresh-before-context-window-limit (prompt scope only)`);
        }
        const budget = FoundationModelsRuntimeTranslator.timeoutBudgetMs(segment.index, firstSegmentMsPerWord, segment.text);
        let finalResult: StructuredTranslationResult;
        let fallback = false;
        let recoveredByFramework = false;
        let didReset = false;
        try {
          finalResult = await FoundationModelsRuntimeTranslator.translateStructuredSegmentWithOptionalTimeout(prompt, segment.text, input.targetLanguage,
            session, segment.index, token, verboseLoggingEnabled, onPartialResult, onDiagnosticEvent, budget);
        } catch (error) {
          token.check();
          const failure = error as Error;
          const mismatch = FoundationModelsRuntimeTranslator.structuredTargetMismatchDetails(failure);
          const repetition = FoundationModelsRuntimeTranslator.repetitionGuardDetails(failure);
          const timeout = FoundationModelsRuntimeTranslator.timeoutMsIfSegmentTimeout(failure);
          if (FoundationModelsRuntimeTranslator.isContextWindowExceededError(failure) && repetition === undefined && timeout === undefined) {
            onDiagnosticEvent?.(`segment=${segment.index}: context-window-exceeded-refresh-session-and-retry (prompt scope only)`);
            session = FoundationModelsRuntimeTranslator.makeTranslationSession(input); sessionSegmentCount = 0; sessionEstimatedContextCost = 0;
            try {
              finalResult = await FoundationModelsRuntimeTranslator.translateStructuredSegmentWithOptionalTimeout(prompt, segment.text, input.targetLanguage,
                session, segment.index, token, verboseLoggingEnabled, onPartialResult, onDiagnosticEvent, budget);
              onDiagnosticEvent?.(`segment=${segment.index}: resumed-after-session-refresh`);
            } catch (retryError) {
              token.check(); fallback = true;
              const recovered = await FoundationModelsRuntimeTranslator.recoverUnsafeTranslationIfPossible(segment.text, input, segment.index, recovery, token, onDiagnosticEvent);
              token.check(); recoveredByFramework = recovered.usedTranslationFrameworkRecovery;
              finalResult = { translation: recovered.translation, outputBreakTagCount: 0 };
              session = await FoundationModelsRuntimeTranslator.resetSessionForNextSegment(input, segment.index, recoveredByFramework, onDiagnosticEvent); didReset = true;
            }
          } else if (FoundationModelsRuntimeTranslator.isUnsafeContentError(failure) || mismatch !== undefined || repetition !== undefined || timeout !== undefined) {
            const reason = mismatch !== undefined ? `structured-target-mismatch expected=${mismatch.expected} actual=${mismatch.actual}` :
              repetition !== undefined ? `repetition-guard-triggered mode=${repetition.mode} chunks=${repetition.chunks}` :
              timeout !== undefined ? `timeout-triggered-ms=${timeout}; timeout-skip-session-refresh-retry` : 'unsafe-no-model-retry';
            onDiagnosticEvent?.(`segment=${segment.index}: ${reason}; fallback-via-translation-framework`);
            fallback = true;
            const recovered = await FoundationModelsRuntimeTranslator.recoverUnsafeTranslationIfPossible(segment.text, input, segment.index, recovery, token, onDiagnosticEvent);
            token.check(); recoveredByFramework = recovered.usedTranslationFrameworkRecovery;
            finalResult = { translation: recovered.translation, outputBreakTagCount: 0 };
            session = await FoundationModelsRuntimeTranslator.resetSessionForNextSegment(input, segment.index, recoveredByFramework, onDiagnosticEvent); didReset = true;
          } else {
            onDiagnosticEvent?.(`segment=${segment.index}: model-failed-no-source-echo (${failure.message})`);
            throw failure;
          }
        }
        const inputSentenceCount = FoundationModelsRuntimeTranslator.sentenceCountByNLTokenizer(segment.text);
        const outputSentenceCount = FoundationModelsRuntimeTranslator.sentenceCountByNLTokenizer(finalResult.translation);
        if (!fallback && FoundationModelsRuntimeTranslator.shouldRetryForSentenceDrop(inputSentenceCount, outputSentenceCount)) {
          onDiagnosticEvent?.(`segment=${segment.index}: sentence-count-drop-detected; sentence-count-drop-fallback-via-translation-framework`);
          const recovered = await FoundationModelsRuntimeTranslator.recoverUnsafeTranslationIfPossible(segment.text, input, segment.index, recovery, token, onDiagnosticEvent);
          token.check(); fallback = true; recoveredByFramework = recovered.usedTranslationFrameworkRecovery;
          finalResult = { translation: recovered.translation, outputBreakTagCount: 0 };
          session = await FoundationModelsRuntimeTranslator.resetSessionForNextSegment(input, segment.index, recoveredByFramework, onDiagnosticEvent); didReset = true;
        }
        token.check();
        onPartialResult?.(segment.index, finalResult.translation);
        const elapsed = Date.now() - started;
        if (segment.index === 0 && firstSegmentMsPerWord === undefined) {
          firstSegmentMsPerWord = elapsed / Math.max(1, FoundationModelsRuntimeTranslator.wordTokenCountByNLTokenizer(segment.text));
          onDiagnosticEvent?.(`segment=0: timeout-baseline-ms=${elapsed}, ms-per-word=${firstSegmentMsPerWord}`);
        }
        onDiagnosticEvent?.(`segment=${segment.index}, sentence-counts={input=${inputSentenceCount}, output=${outputSentenceCount}}, br-counts={input=${FoundationModelsRuntimeTranslator.lineBreakTagCount(FoundationModelsRuntimeTranslator.sourceTextForPrompt(segment.text))}, output=${finalResult.outputBreakTagCount}}, unsafe-fallback=${fallback}, tf-recovered=${recoveredByFramework}, duration-ms=${elapsed}`);
        outputs.push(new SegmentOutput(segment.index, segment.text, finalResult.translation, fallback, recoveredByFramework));
        if (!didReset) { sessionSegmentCount++; sessionEstimatedContextCost += FoundationModelsRuntimeTranslator.estimatedContextCost(prompt.length); }
        if (didReset || segment.role === SegmentRole.LEADING) {
          session = FoundationModelsRuntimeTranslator.makeTranslationSession(input); sessionSegmentCount = 0; sessionEstimatedContextCost = 0;
          if (segment.role === SegmentRole.LEADING) onDiagnosticEvent?.(`segment=${segment.index}: session-reset-after-leading-segment (prompt scope only)`);
        }
      }
      return outputs;
    });
  }

  private static async translateStructuredSegmentWithRetry(prompt: string, sourceText: string, expectedTargetLanguage: string,
    session: TranslationSession, segmentIndex: number, token: TranslationCancellation, verbose: () => boolean,
    onPartialResult: PartialResultHandler | undefined, onDiagnosticEvent: DiagnosticEventHandler | undefined,
    stallTimeoutMs: number): Promise<StructuredTranslationResult> {
    if (verbose()) onDiagnosticEvent?.(`verbose model-input segment=${segmentIndex}, source=${FoundationModelsRuntimeTranslator.sanitizedForLog(sourceText)}, prompt=${FoundationModelsRuntimeTranslator.sanitizedForLog(prompt)}`);
    // Source deliberately does not retry malformed structured content; surface the failure instead of echoing input.
    return FoundationModelsRuntimeTranslator.translateSegment(prompt, sourceText, expectedTargetLanguage, session, segmentIndex,
      token, verbose, onPartialResult, onDiagnosticEvent, stallTimeoutMs);
  }
  private static translateStructuredSegmentWithOptionalTimeout(prompt: string, sourceText: string, target: string,
    session: TranslationSession, index: number, token: TranslationCancellation, verbose: () => boolean,
    partial: PartialResultHandler | undefined, diagnostic: DiagnosticEventHandler | undefined,
    budget?: number): Promise<StructuredTranslationResult> {
    return FoundationModelsRuntimeTranslator.translateStructuredSegmentWithRetry(prompt, sourceText, target, session, index, token, verbose,
      partial, diagnostic, budget ?? FoundationModelsRuntimeTranslator.STREAM_CHUNK_STALL_TIMEOUT_MS);
  }
  private static async translateSegment(prompt: string, sourceText: string, target: string, session: TranslationSession,
    index: number, token: TranslationCancellation, verbose: () => boolean, partial: PartialResultHandler | undefined,
    diagnostic: DiagnosticEventHandler | undefined, stallTimeoutMs: number): Promise<StructuredTranslationResult> {
    const payload = await FoundationModelsRuntimeTranslator.streamSegmentResponse(prompt, session, index, token, verbose, partial,
      diagnostic, stallTimeoutMs, FoundationModelsRuntimeTranslator.wordTokenCountByNLTokenizer(sourceText));
    token.check();
    if (verbose()) diagnostic?.(`verbose model-output segment=${index}, payload={targetLanguage=${payload.targetLanguage}, translation=${FoundationModelsRuntimeTranslator.sanitizedForLog(payload.translation)}}`);
    return FoundationModelsRuntimeTranslator.validateStructuredTranslation(payload, target, sourceText);
  }

  private static streamSegmentResponse(prompt: string, session: TranslationSession, index: number,
    token: TranslationCancellation, verbose: () => boolean, partial: PartialResultHandler | undefined,
    diagnostic: DiagnosticEventHandler | undefined, stallTimeoutMs: number, sourceWords: number): Promise<StructuredTranslationPayload> {
    if (FoundationModelsRuntimeTranslator.nativeChatActive) return Promise.reject(new Error('The on-device model is still generating after a timeout or Stop. Retry after native completion.'));
    FoundationModelsRuntimeTranslator.nativeChatActive = true;
    const questionId = ++FoundationModelsRuntimeTranslator.questionId;
    const info: localChatModel.QuestionInfo = { questionId: questionId, content: `${session.instructions}\nReturn one JSON object only: {"targetLanguage":"language code","translation":"translated text"}. No markdown fences.\n${prompt}` };
    const config: localChatModel.Config = { isStream: true };
    let finishDrain: () => void = () => {};
    const drain = new Promise<void>((resolve) => { finishDrain = () => { FoundationModelsRuntimeTranslator.nativeChatActive = false; resolve(); }; });
    token.nativeWork.push(drain);
    return new Promise<StructuredTranslationPayload>((resolve, reject) => {
      let settled = false;
      let dispatchSettled = false;
      let callbackFinished = false;
      let drainFinished = false;
      let finalPayload: StructuredTranslationPayload | undefined;
      let chunks = 0;
      let lastPartial: string | undefined;
      let previous: string | undefined;
      const signatures: string[] = [];
      let nonWordChunks = 0, nonWordChars = 0, monoChunks = 0, monoChars = 0;
      const progress = new StreamChunkProgress();
      let watchdog: number | undefined;
      const clearWatchdog = (): void => { if (watchdog !== undefined) clearTimeout(watchdog); watchdog = undefined; };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true; clearWatchdog(); token.onCancel = undefined; reject(error);
      };
      const completeDrain = (): void => {
        if (!dispatchSettled || !callbackFinished) return;
        if (!drainFinished) { drainFinished = true; finishDrain(); }
        if (!settled && finalPayload !== undefined) {
          settled = true; clearWatchdog(); token.onCancel = undefined; resolve(finalPayload);
        }
      };
      const checkStall = (): void => {
        if (settled) return;
        if (progress.elapsedSinceLastChunkMs() >= stallTimeoutMs) {
          progress.markTimedOut();
          fail(new FoundationModelsRuntimeError(RuntimeErrorKind.SEGMENT_PROCESSING_TIMEOUT,
            `Segment stream stalled after ${stallTimeoutMs} ms. Native generation may continue until completion.`, stallTimeoutMs));
        } else watchdog = setTimeout(checkStall, Math.min(250, stallTimeoutMs));
      };
      token.onCancel = () => fail(new TranslationCancelledError());
      watchdog = setTimeout(checkStall, Math.min(250, stallTimeoutMs));
      try {
        localChatModel.chat(info, config, (error: BusinessError, answer: localChatModel.Answer) => {
          if (error !== undefined && error !== null) {
            callbackFinished = true; fail(new Error(`On-device model failed: ${error.message} (code ${error.code})`)); completeDrain(); return;
          }
          if (answer === undefined || answer === null || typeof answer.questionId !== 'number' ||
            typeof answer.content !== 'string' || typeof answer.isFinished !== 'boolean') {
            fail(new FoundationModelsRuntimeError(RuntimeErrorKind.INVALID_FORMAT, 'On-device model returned an invalid callback response.'));
            return;
          }
          if (answer.questionId !== questionId) return;
          if (answer.isFinished) callbackFinished = true;
          completeDrain();
          if (settled || token.cancelled) return;
          progress.bump(); chunks++;
          const raw = answer.content;
          if (verbose()) diagnostic?.(`verbose model-output-raw segment=${index}, chunk=${chunks}, raw=${FoundationModelsRuntimeTranslator.sanitizedForLog(raw)}`);
          try {
            const extracted = FoundationModelsRuntimeTranslator.extractPartialTranslation(raw);
            if (extracted !== undefined) {
              const normalized = FoundationModelsRuntimeTranslator.normalizeBreakTagsToNewline(extracted);
              const words = FoundationModelsRuntimeTranslator.wordTokenCountByNLTokenizer(normalized);
              const delta = FoundationModelsRuntimeTranslator.chunkDeltaForRepetitionDetection(previous, normalized);
              if (FoundationModelsRuntimeTranslator.isLikelyNonWordExplosionChunk(delta)) { nonWordChunks++; nonWordChars += delta.length; }
              else { nonWordChunks = 0; nonWordChars = 0; }
              if (FoundationModelsRuntimeTranslator.isLikelyMonotoneCharacterExplosionChunk(delta)) { monoChunks++; monoChars += delta.length; }
              else { monoChunks = 0; monoChars = 0; }
              const signature = FoundationModelsRuntimeTranslator.semanticSignatureForRepetitionDetection(delta);
              let mode = '';
              if (chunks >= FoundationModelsRuntimeTranslator.REPETITION_GUARD_MIN_CHUNK_COUNT && words > Math.max(1, sourceWords) * FoundationModelsRuntimeTranslator.REPETITION_GUARD_OUTPUT_WORD_MULTIPLIER) mode = 'word-count-multiplier';
              else if (nonWordChunks >= FoundationModelsRuntimeTranslator.NON_WORD_EXPLOSION_LOOKBACK_CHUNKS && nonWordChars >= FoundationModelsRuntimeTranslator.NON_WORD_EXPLOSION_MIN_ADDED_CHARS) mode = 'nonword-explosion-3';
              else if (monoChunks >= FoundationModelsRuntimeTranslator.MONO_CHAR_EXPLOSION_LOOKBACK_CHUNKS && monoChars >= FoundationModelsRuntimeTranslator.MONO_CHAR_EXPLOSION_MIN_ADDED_CHARS) mode = 'monochar-explosion-2';
              else if (FoundationModelsRuntimeTranslator.isRepeatedRecentChunkSignature(signature, signatures)) mode = 'semantic-lookback-3';
              if (mode.length > 0) throw new FoundationModelsRuntimeError(RuntimeErrorKind.SUSPECTED_STREAM_REPETITION,
                `Suspected stream repetition (${mode}).`, 0, '', '', mode, sourceWords, words, chunks);
              if (signature.length > 0) { signatures.push(signature); if (signatures.length > FoundationModelsRuntimeTranslator.SEMANTIC_REPETITION_LOOKBACK_CHUNKS) signatures.shift(); }
              previous = normalized;
              if (normalized !== lastPartial) { lastPartial = normalized; partial?.(index, normalized); }
            }
            if (answer.isFinished) {
              const payload = JSON.parse(raw) as StructuredTranslationPayload;
              if (payload === null || typeof payload.targetLanguage !== 'string' || typeof payload.translation !== 'string') {
                throw new FoundationModelsRuntimeError(RuntimeErrorKind.INVALID_FORMAT, 'Model output was not valid structured translation content.');
              }
              finalPayload = payload; completeDrain();
            }
          } catch (parseError) { fail(parseError as Error); }
        }).then(() => { dispatchSettled = true; completeDrain(); }, (error: BusinessError) => {
          dispatchSettled = true; callbackFinished = true;
          fail(new Error(`On-device model failed: ${error.message} (code ${error.code})`)); completeDrain();
        });
      } catch (error) {
        dispatchSettled = true; callbackFinished = true; fail(error as Error); completeDrain();
      }
      if (token.cancelled) fail(new TranslationCancelledError());
    });
  }

  private static extractPartialTranslation(raw: string): string | undefined {
    const match = /"translation"\s*:\s*"/.exec(raw);
    if (match === null) return undefined;
    let result = '', escaping = false;
    for (let index = match.index + match[0].length; index < raw.length; index++) {
      const char = raw[index];
      if (escaping) {
        switch (char) {
          case 'n': result += '\n'; break;
          case 'r': result += '\r'; break;
          case 't': result += '\t'; break;
          case 'u': {
            const hex = raw.slice(index + 1, index + 5);
            if (hex.length !== 4) return result.trim().length === 0 ? undefined : result.trim();
            if (!/^[0-9a-f]{4}$/i.test(hex)) return undefined;
            result += String.fromCharCode(parseInt(hex, 16)); index += 4; break;
          }
          default: result += char;
        }
        escaping = false;
      } else if (char === '\\') escaping = true;
      else if (char === '"') break;
      else result += char;
    }
    return result.trim().length === 0 ? undefined : result.trim();
  }
  private static instructions(input: TranslationInput): string {
    return `You are a translation engine for ${input.sourceLanguage} -> ${input.targetLanguage}.\nReturn translated text only inside translation.\nDo not omit content.\nKeep sentence count unchanged.\nPreserve all \`</br>\` tokens exactly (same count and order).\nKeep punctuation/structure when possible.`;
  }
  private static sensitiveContentSafeInstructions(input: TranslationInput): string {
    return `You are a universal translation engine.\nTranslate from ${input.sourceLanguage} to ${input.targetLanguage}.\nThe input can include politics, war, safety, or other sensitive topics.\nYour role is strictly translation, not policy analysis.\nKeep meaning and tone faithful.\nDo not refuse, summarize, or add warnings.\nIf any part cannot be translated due to safety restrictions, keep only that part in the original language and annotate it with "原文ママ" inside "translation".`;
  }
  private static promptForSegment(segment: TextSegment, input: TranslationInput): string {
    const lines: string[] = ['Translate this segment.'];
    const styles = FoundationModelsRuntimeTranslator.promptStyleDirectives(input.targetLanguage, input.preferredLanguages);
    if (styles.length > 0) { lines.push('Style directives:'); for (const style of styles) lines.push(`- ${style}`); }
    if (input.glossaryMatches.length > 0) {
      lines.push('Glossary (prefer exact targets):');
      for (const match of input.glossaryMatches) lines.push(`${match.source}=${match.target}`);
    }
    if (input.protectedTokens.length > 0) lines.push(`Do not translate tokens: ${input.protectedTokens.map((item) => item.value).join(', ')}`);
    lines.push('Source:'); lines.push(FoundationModelsRuntimeTranslator.sourceTextForPrompt(segment.text)); return lines.join('\n');
  }
  private static promptForSensitiveContentSegment(segment: TextSegment, input: TranslationInput): string {
    const lines: string[] = ['Task: direct translation only.', `Source language: ${input.sourceLanguage}`, `Target language: ${input.targetLanguage}`];
    for (const style of FoundationModelsRuntimeTranslator.promptStyleDirectives(input.targetLanguage, input.preferredLanguages)) lines.push(`- ${style}`);
    if (input.protectedTokens.length > 0) lines.push(`Protected tokens (do not translate): ${input.protectedTokens.map((item) => item.value).join(', ')}`);
    lines.push('The source is HTML-like text. STRICT REQUIREMENT: Preserve all `</br>` tokens exactly as in source (same count and order). Do not replace, remove, or add `</br>`.');
    lines.push('Translate every sentence in the source text; do not omit any part. Keep the same number of sentences.');
    lines.push('Source text:'); lines.push(FoundationModelsRuntimeTranslator.sourceTextForPrompt(segment.text)); return lines.join('\n');
  }
  private static strictPromptForSegment(source: string, target: string, preferences: string[]): string {
    const lines: string[] = ['Translate this text strictly.', 'Rules:', `- target language: ${target}`];
    for (const style of FoundationModelsRuntimeTranslator.promptStyleDirectives(target, preferences)) lines.push(`- ${style}`);
    lines.push('- source is HTML-like text', '- STRICT REQUIREMENT: preserve all `</br>` tokens exactly as in source (same count and order)',
      '- do not replace, remove, or add `</br>`', '- translate every sentence; do not omit any part',
      '- keep the same number of sentences; do not merge, split, summarize, or drop sentences',
      '- output translation only, no notes or placeholders',
      '- translation must not be the kind label (heading, general, dialogue, ui-labels, lists, codes_or_path)', 'Source text:', FoundationModelsRuntimeTranslator.sourceTextForPrompt(source));
    return lines.join('\n');
  }
  private static promptStyleDirectives(target: string, preferred: string[]): string[] {
    if (FoundationModelsRuntimeTranslator.normalizedLanguageCode(target) === 'zh' && FoundationModelsRuntimeTranslator.prefersTraditionalChineseOverSimplified(preferred)) return ['Translate into Traditional Chinese script.'];
    if (FoundationModelsRuntimeTranslator.normalizedLanguageCode(target) === 'en' && FoundationModelsRuntimeTranslator.prefersBritishEnglish(preferred)) return ['Use British English style.'];
    return [];
  }
  private static prefersTraditionalChineseOverSimplified(preferred: string[]): boolean {
    for (const value of preferred) { const choice = FoundationModelsRuntimeTranslator.chineseScriptPreference(value); if (choice !== undefined) return choice === ChineseScriptPreference.TRADITIONAL; }
    return false;
  }
  private static prefersBritishEnglish(preferred: string[]): boolean {
    for (const value of preferred) { const parts = FoundationModelsRuntimeTranslator.normalizedLocaleIdentifier(value).split('-'); if (parts[0] === 'en') return parts.includes('gb') || parts.includes('uk'); }
    return false;
  }
  private static chineseScriptPreference(value: string): ChineseScriptPreference | undefined {
    const parts = FoundationModelsRuntimeTranslator.normalizedLocaleIdentifier(value).split('-');
    if (parts[0] !== 'zh') return undefined;
    if (parts.includes('hant')) return ChineseScriptPreference.TRADITIONAL;
    if (parts.includes('hans')) return ChineseScriptPreference.SIMPLIFIED;
    if (parts.includes('tw') || parts.includes('hk') || parts.includes('mo')) return ChineseScriptPreference.TRADITIONAL;
    if (parts.includes('cn') || parts.includes('sg') || parts.includes('my')) return ChineseScriptPreference.SIMPLIFIED;
    return undefined;
  }
  private static normalizedLocaleIdentifier(value: string): string { return value.trim().toLowerCase().replace(/_/g, '-'); }
  private static async fallbackSafeSegmentTranslation(prompt: string, source: string, target: string,
    session: TranslationSession, index: number, token: TranslationCancellation, verbose: () => boolean,
    partial?: PartialResultHandler, diagnostic?: DiagnosticEventHandler): Promise<StructuredTranslationResult> {
    return FoundationModelsRuntimeTranslator.translateStructuredSegmentWithRetry(prompt, source, target, session, index, token, verbose,
      partial, diagnostic, FoundationModelsRuntimeTranslator.STREAM_CHUNK_STALL_TIMEOUT_MS);
  }
  private static validateStructuredTranslation(payload: StructuredTranslationPayload, target: string, source: string): StructuredTranslationResult {
    const actual = FoundationModelsRuntimeTranslator.normalizedLanguageCode(payload.targetLanguage), expected = FoundationModelsRuntimeTranslator.normalizedLanguageCode(target);
    if (actual !== expected) throw new FoundationModelsRuntimeError(RuntimeErrorKind.STRUCTURED_OUTPUT_TARGET_MISMATCH,
      `Structured output target mismatch. expected=${expected}, actual=${actual}`, 0, expected, actual);
    if (payload.translation.trim().length === 0) throw new FoundationModelsRuntimeError(RuntimeErrorKind.EMPTY_TRANSLATION, 'Structured output translation was empty.');
    const sanitized = FoundationModelsRuntimeTranslator.sanitizeStructuredLeakage(payload.translation.trim());
    if (sanitized.length === 0 || FoundationModelsRuntimeTranslator.isPlaceholderTranslation(sanitized)) throw new FoundationModelsRuntimeError(RuntimeErrorKind.PLACEHOLDER_TRANSLATION, 'Structured output was not a valid translation.');
    const completed = FoundationModelsRuntimeTranslator.appendMissingTrailingBreakMarkers(FoundationModelsRuntimeTranslator.sourceTextForPrompt(source), sanitized);
    const result: StructuredTranslationResult = { translation: FoundationModelsRuntimeTranslator.normalizeBreakTagsToNewline(completed), outputBreakTagCount: FoundationModelsRuntimeTranslator.lineBreakTagCount(completed) };
    return result;
  }
  private static sourceTextForPrompt(text: string): string { return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, FoundationModelsRuntimeTranslator.LINE_BREAK_MARKER); }
  private static sentenceCountByNLTokenizer(text: string): number {
    // shortcut: deterministic punctuation counts, replace only with a verified native NLTokenizer equivalent.
    const value = text.trim(); return value.length === 0 ? 0 : Math.max(1, (value.match(/[^.!?。！？\n]+[.!?。！？]*|[.!?。！？]+/g) ?? []).length);
  }
  private static shouldRetryForSentenceDrop(input: number, output: number): boolean { return input > 0 && !(input === 2 && output === 1) && output * 2 < input; }
  private static normalizeBreakTagsToNewline(text: string): string {
    return text.replace(/<\/\s*p\s*>\s*<\s*p(?:\s+[^>]*)?\s*>/gi, '\n')
      .replace(/<\/\s*p\s*>/gi, '\n').replace(/<\s*p(?:\s+[^>]*)?\s*>/gi, '')
      .replace(/<\s*\/?\s*br(?:\s*\/)?\s*>/gi, '\n');
  }
  private static lineBreakTagCount(text: string): number { return (text.match(/<\s*\/?\s*br(?:\s*\/)?\s*>|<\/\s*p\s*>\s*<\s*p(?:\s+[^>]*)?\s*>|<\/\s*p\s*>/gi) ?? []).length; }
  private static appendMissingTrailingBreakMarkers(source: string, output: string): string {
    return output + FoundationModelsRuntimeTranslator.LINE_BREAK_MARKER.repeat(Math.max(0, FoundationModelsRuntimeTranslator.trailingBreakMarkerCount(source) - FoundationModelsRuntimeTranslator.trailingBreakMarkerCount(output)));
  }
  private static trailingBreakMarkerCount(text: string): number {
    let count = 0; while (text.endsWith(FoundationModelsRuntimeTranslator.LINE_BREAK_MARKER)) { count++; text = text.slice(0, -FoundationModelsRuntimeTranslator.LINE_BREAK_MARKER.length); } return count;
  }
  private static replaceRegex(pattern: string, text: string, replacement: string): string { return text.replace(new RegExp(pattern, 'gu'), replacement); }
  private static isPlaceholderTranslation(text: string): boolean {
    return ['<translated text>', '<translation>', '[translated text]', '[translation]', '(translated text)', '(translation)', '{translated text}', '{translation}'].includes(text.trim().toLowerCase());
  }
  private static sanitizeStructuredLeakage(text: string): string { return text.split(/(?:"|”)?\}\s*[\p{L}\p{N}]/u)[0].trim().replace(/^["”]+|["”]+$/g, '').trim(); }
  private static normalizedLanguageCode(value: string): string { return value.toLowerCase().split('-')[0]; }
  private static shouldRetryOrFallbackForGeneration(error: Error): boolean { return /GenerationError|unsafe|safety|content|policy/i.test(error.name + ' ' + error.message); }
  private static isUnsafeContentError(error: Error): boolean {
    const pending: ModelFailure[] = [error as ModelFailure];
    const visited = new Set<ModelFailure>();
    while (pending.length > 0) {
      const current = pending.pop() as ModelFailure;
      if (visited.has(current)) continue;
      visited.add(current);
      if (FoundationModelsRuntimeTranslator.isUnsafeSignal(current)) return true;
      if (current.cause !== undefined) pending.push(current.cause);
      if (current.errors !== undefined) for (const nested of current.errors) pending.push(nested);
    }
    return false;
  }
  private static isUnsafeSignal(error: ModelFailure): boolean {
    if ((error.domain ?? '').toLowerCase().includes('languagemodelsession.generationerror') && error.code === 2) return true;
    return /unsafe|safety|policy|content filter|prohibited|restricted|disallowed|moderation/i.test(
      `${error.message} ${error.failureReason ?? ''} ${error.recoverySuggestion ?? ''}`);
  }
  private static sourceFallbackTranslation(sourceText: string): string {
    throw new TranslationPlatformUnavailableError(`model failed for a ${sourceText.length}-character segment and standard recovery is unavailable. Source text was retained in the editor.`);
  }
  private static async recoverUnsafeTranslationIfPossible(source: string, input: TranslationInput, index: number,
    recovery: UnsafeSegmentRecoveryEngine, token: TranslationCancellation, diagnostic?: DiagnosticEventHandler): Promise<RecoveredTranslation> {
    diagnostic?.(`segment=${index}: attempting-translation-framework-recovery`);
    const recovered = await token.waitFor(recovery.recoverUnsafeTranslation(source, input.detectedLanguageCode ?? input.sourceLanguage, input.targetLanguage,
      (message: string) => { if (!token.cancelled) diagnostic?.(message); }));
    if (recovered === undefined || recovered.trim().length === 0) {
      diagnostic?.(`segment=${index}: translation-framework-recovery-unavailable`);
      FoundationModelsRuntimeTranslator.sourceFallbackTranslation(source);
    }
    diagnostic?.(`segment=${index}: translation-framework-recovery-succeeded`);
    const result: RecoveredTranslation = { translation: FoundationModelsRuntimeTranslator.normalizeRecoveredUnsafeTranslation(recovered as string, source), usedTranslationFrameworkRecovery: true };
    return result;
  }
  private static makeTranslationSession(input: TranslationInput): TranslationSession {
    // shortcut: SDK has no session/reset/guardrail API, keep request prompts isolated until one is verified.
    const session: TranslationSession = { instructions: FoundationModelsRuntimeTranslator.instructions(input) }; return session;
  }
  private static resetSessionForNextSegment(input: TranslationInput, index: number, prewarm: boolean,
    diagnostic?: DiagnosticEventHandler): Promise<TranslationSession> {
    if (prewarm) diagnostic?.(`segment=${index}: native prewarm/reset unsupported; next segment receives fresh instructions`);
    return Promise.resolve(FoundationModelsRuntimeTranslator.makeTranslationSession(input));
  }
  private static normalizeRecoveredUnsafeTranslation(recovered: string, source: string): string {
    return FoundationModelsRuntimeTranslator.normalizeBreakTagsToNewline(FoundationModelsRuntimeTranslator.appendMissingTrailingBreakMarkers(FoundationModelsRuntimeTranslator.sourceTextForPrompt(source), FoundationModelsRuntimeTranslator.sourceTextForPrompt(recovered)));
  }
  private static isContextWindowExceededError(error: Error): boolean {
    return error instanceof FoundationModelsRuntimeError && (error.kind === RuntimeErrorKind.SEGMENT_PROCESSING_TIMEOUT || error.kind === RuntimeErrorKind.SUSPECTED_STREAM_REPETITION) || /context window|exceeded model context window size/i.test(error.message);
  }
  private static repetitionGuardDetails(error: Error): RepetitionDetails | undefined {
    if (!(error instanceof FoundationModelsRuntimeError) || error.kind !== RuntimeErrorKind.SUSPECTED_STREAM_REPETITION) return undefined;
    const result: RepetitionDetails = { sourceWords: error.sourceWords, outputWords: error.outputWords, chunks: error.chunks, mode: error.mode }; return result;
  }
  private static timeoutMsIfSegmentTimeout(error: Error): number | undefined { return error instanceof FoundationModelsRuntimeError && error.kind === RuntimeErrorKind.SEGMENT_PROCESSING_TIMEOUT ? error.timeoutMs : undefined; }
  private static structuredTargetMismatchDetails(error: Error): TargetMismatchDetails | undefined {
    if (!(error instanceof FoundationModelsRuntimeError) || error.kind !== RuntimeErrorKind.STRUCTURED_OUTPUT_TARGET_MISMATCH) return undefined;
    const result: TargetMismatchDetails = { expected: error.expected, actual: error.actual }; return result;
  }
  private static shouldRefreshSessionProactively(count: number, cost: number, next: number): boolean {
    return count > 0 && (count >= FoundationModelsRuntimeTranslator.MAX_SEGMENTS_PER_SESSION || next >= FoundationModelsRuntimeTranslator.LARGE_PROMPT_CHARS_THRESHOLD || cost + FoundationModelsRuntimeTranslator.estimatedContextCost(next) > FoundationModelsRuntimeTranslator.MAX_ESTIMATED_CONTEXT_COST_PER_SESSION);
  }
  private static estimatedContextCost(chars: number): number { return chars * 2 + 400; }
  private static timeoutBudgetMs(index: number, baseline: number | undefined, text: string): number | undefined {
    return index > 0 && baseline !== undefined ? Math.max(baseline * Math.max(1, FoundationModelsRuntimeTranslator.wordTokenCountByNLTokenizer(text)) * FoundationModelsRuntimeTranslator.SEGMENT_WORD_TIMEOUT_SAFETY_FACTOR, FoundationModelsRuntimeTranslator.MINIMUM_SEGMENT_TIMEOUT_MS) : undefined;
  }
  private static wordTokenCountByNLTokenizer(text: string): number {
    // shortcut: Unicode word approximation, validate/recalibrate on-device budgets against real tokenizer vectors.
    return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  }
  private static semanticSignatureForRepetitionDetection(text: string): string {
    return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, '').trim().replace(/\s+/g, ' ');
  }
  private static isRepeatedRecentChunkSignature(signature: string, recent: string[]): boolean { return signature.length >= FoundationModelsRuntimeTranslator.SEMANTIC_REPETITION_MIN_SIGNATURE_LENGTH && recent.includes(signature); }
  private static chunkDeltaForRepetitionDetection(previous: string | undefined, current: string): string { return previous === undefined ? current : current.slice(FoundationModelsRuntimeTranslator.commonPrefixLength(previous, current)); }
  private static commonPrefixLength(left: string, right: string): number { let index = 0; while (index < left.length && index < right.length && left[index] === right[index]) index++; return index; }
  private static isLikelyNonWordExplosionChunk(delta: string): boolean { return delta.length > 0 && FoundationModelsRuntimeTranslator.wordTokenCountByNLTokenizer(delta) === 0 && ((delta.match(/[\n\r\u2028\u2029]/g) ?? []).length >= 2 || delta.replace(/\s/g, '').length >= 6); }
  private static isLikelyMonotoneCharacterExplosionChunk(delta: string): boolean {
    const value = delta.trim(); if (value.length < 8) return false;
    const counts = new Map<string, number>(); let total = 0, max = 0;
    for (const char of value) { const count = (counts.get(char) ?? 0) + 1; counts.set(char, count); total++; max = Math.max(max, count); }
    return total > 0 && max / total >= 0.9;
  }
  static sanitizedForLog(text?: string): string | undefined {
    if (text === undefined) return undefined;
    const compact = text.replace(/\n/g, '\\n').trim(); if (compact.length === 0) return undefined;
    const chars = Array.from(compact);
    return chars.length <= 1500 ? compact : `${chars.slice(0, 1000).join('')}...(truncated ${chars.length - 1350} chars)...${chars.slice(-350).join('')}`;
  }
}
