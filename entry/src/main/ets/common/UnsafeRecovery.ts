import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PendingRequest, RecoveryChunk, RecoveryChunkKind, SourceLanguageResolutionReason } from '../model/TranslationModels';
import { UnsafeSegmentRecoveryEngine } from './TranslationProtocols';

export { PendingRequest, RecoveryChunk, RecoveryChunkKind, SourceLanguageResolutionReason } from '../model/TranslationModels';

export enum MissingLanguageKind {
  SOURCE = 'missing_source_language',
  TARGET = 'missing_target_language',
  SOURCE_AND_TARGET = 'missing_source_and_target_language',
  UNSUPPORTED_PAIR = 'unsupported_language_pairing'
}

export enum RecoveryAvailabilityStatus {
  INSTALLED = 'installed',
  SUPPORTED = 'supported',
  UNSUPPORTED = 'unsupported',
  UNKNOWN = 'unknown'
}

export enum RecoveryTranslationErrorKind {
  UNSUPPORTED_SOURCE_LANGUAGE = 'unsupportedSourceLanguage',
  UNSUPPORTED_TARGET_LANGUAGE = 'unsupportedTargetLanguage',
  UNSUPPORTED_LANGUAGE_PAIRING = 'unsupportedLanguagePairing',
  NOT_INSTALLED = 'notInstalled'
}

export class RecoveryTranslationError extends Error {
  readonly kind: RecoveryTranslationErrorKind;
  readonly domain: string;
  readonly code: number;
  readonly debugDescription: string;

  constructor(message: string, kind: RecoveryTranslationErrorKind, domain: string = '', code: number = 0,
    debugDescription: string = '') {
    super(message);
    this.kind = kind;
    this.domain = domain;
    this.code = code;
    this.debugDescription = debugDescription;
  }
}

export class RecoveryTimeoutError extends Error {
  readonly stage: string;
  constructor(stage: string) {
    super(`Translation recovery timed out at ${stage}`);
    this.stage = stage;
  }
}

export class RecoveryCancelledError extends Error {
  constructor() { super('Translation recovery cancelled'); }
}

export class RecoveryPlatformUnavailableError extends Error {
  constructor() { super('Standard translation recovery is not available on this platform.'); }
}

export class RecoveryCancellation {
  cancelled: boolean = false;
  private listeners: (() => void)[] = [];

  check(): void {
    if (this.cancelled) { throw new RecoveryCancelledError(); }
  }

  addListener(listener: () => void): void {
    if (this.cancelled) { listener(); } else { this.listeners.push(listener); }
  }

  removeListener(listener: () => void): void {
    this.listeners = this.listeners.filter((entry: () => void): boolean => entry !== listener);
  }

  cancel(): void {
    this.cancelled = true;
    const listeners: (() => void)[] = this.listeners;
    this.listeners = [];
    for (const listener of listeners) { listener(); }
  }
}

export interface RecoveryConfiguration {
  source?: string;
  target?: string;
  generation: string;
}

export interface RecoveryTranslationRequest {
  sourceText: string;
  clientIdentifier: string;
}

export interface RecoveryTranslationResponse {
  targetText: string;
  clientIdentifier?: string;
}

// This boundary represents the source's session; no platform implementation is claimed or registered.
export interface RecoveryLanguageAvailability {
  status(sourceLanguage: string | undefined, targetLanguage: string | undefined,
    cancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus>;
  statusForText(sourceText: string, targetLanguage: string | undefined,
    cancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus>;
}

export interface RecoveryTranslationSession {
  availability: RecoveryLanguageAvailability;
  prepareTranslation(cancellation: RecoveryCancellation): Promise<void>;
  translations(requests: RecoveryTranslationRequest[],
    cancellation: RecoveryCancellation): Promise<RecoveryTranslationResponse[]>;
}

interface SourceLanguageResolution {
  code?: string;
  reason: SourceLanguageResolutionReason;
}

export interface UnsafeRecoveryImplementation {
  sourceSymbol: string;
  productionSelected: boolean;
}

export const UNSAFE_RECOVERY_IMPLEMENTATIONS: UnsafeRecoveryImplementation[] = [
  { sourceSymbol: 'TranslationFrameworkUnsafeRecoveryController', productionSelected: true },
  { sourceSymbol: 'NoOpUnsafeSegmentRecoveryEngine', productionSelected: false }
];

// The source itself defines this no-op; it is distinct from the production recovery controller.
export class NoOpUnsafeSegmentRecoveryEngine implements UnsafeSegmentRecoveryEngine {
  async recoverUnsafeTranslation(sourceText: string, sourceLanguage: string, targetLanguage: string,
    onDiagnosticEvent?: (message: string) => void): Promise<string | undefined> {
    return undefined;
  }
}

export class TranslationFrameworkUnsafeRecoveryController implements UnsafeSegmentRecoveryEngine {
  private static readonly LOGGER: string = 'translation-framework';
  private static readonly TRANSLATION_CALL_TIMEOUT_NANOSECONDS: number = 25000000000;
  private static readonly PENDING_REQUEST_WATCHDOG_NANOSECONDS: number = 45000000000;
  private static preferencesStore?: preferences.Preferences;

  private currentConfiguration?: RecoveryConfiguration;
  private currentRequestGeneration: string = util.generateRandomUUID();
  private pendingRequest?: PendingRequest;
  private pendingContinuation?: (translatedText: string | undefined) => void;
  private lastSuccessfulSourceLanguageCode?: string;
  private pendingRequestWatchdogTask?: number;
  private pendingCancellation?: RecoveryCancellation;
  private processingRequests: Set<string> = new Set<string>();
  private processingTasks: Promise<void>[] = [];
  private session?: RecoveryTranslationSession;

  constructor(context?: common.Context) {
    if (context !== undefined) { this.initialize(context); }
  }

  initialize(context: common.Context): void {
    const options: preferences.Options = { name: 'zenBabel' };
    TranslationFrameworkUnsafeRecoveryController.preferencesStore = preferences.getPreferencesSync(context, options);
  }

  setSession(session?: RecoveryTranslationSession): void { this.session = session; }

  get configuration(): RecoveryConfiguration | undefined { return this.currentConfiguration; }
  get requestGeneration(): string { return this.currentRequestGeneration; }

  private log(message: string): void {
    hilog.debug(0x0000, TranslationFrameworkUnsafeRecoveryController.LOGGER, '%{public}s [request=%{public}s]',
      message, this.pendingRequest?.id ?? 'none');
  }

  async recoverUnsafeTranslation(sourceText: string, sourceLanguage: string, targetLanguage: string,
    onDiagnosticEvent?: (message: string) => void): Promise<string | undefined> {
    const active: PendingRequest | undefined = this.pendingRequest;
    if (active !== undefined) {
      onDiagnosticEvent?.(`translation-framework-recovery: skipped-because-request-is-already-active id=${active.id}`);
      this.log(`stale-request-reset-triggered id=${active.id}`);
      this.finishPendingRequest(undefined, active.id);
    }
    const requestID: string = util.generateRandomUUID();
    const resolution: SourceLanguageResolution = this.resolveSourceLanguageCode(sourceLanguage, targetLanguage);
    const request: PendingRequest = {
      id: requestID, sourceText: sourceText, sourceLanguage: sourceLanguage,
      resolvedSourceLanguageCode: resolution.code, sourceLanguageResolutionReason: resolution.reason,
      targetLanguage: targetLanguage, onDiagnosticEvent: onDiagnosticEvent
    };
    this.pendingRequest = request;
    this.pendingCancellation = new RecoveryCancellation();
    this.currentRequestGeneration = util.generateRandomUUID();
    const configuration: RecoveryConfiguration = {
      source: this.localeLanguage(resolution.code ?? sourceLanguage), target: this.localeLanguage(targetLanguage),
      generation: this.currentRequestGeneration
    };
    this.currentConfiguration = configuration;
    const result: Promise<string | undefined> = new Promise<string | undefined>((resolve): void => {
      this.pendingContinuation = resolve;
    });
    this.pendingRequestWatchdogTask = setTimeout((): void => {
      if (this.pendingRequest?.id !== requestID) { return; }
      request.onDiagnosticEvent?.(`translation-framework-recovery: watchdog-timeout id=${requestID}`);
      this.log(`watchdog-timeout id=${requestID}`);
      this.finishPendingRequest(undefined, requestID);
    }, TranslationFrameworkUnsafeRecoveryController.PENDING_REQUEST_WATCHDOG_NANOSECONDS / 1000000);
    onDiagnosticEvent?.(`translation-framework-recovery: source-language requested=${sourceLanguage} resolved=${resolution.code ?? 'auto'} reason=${resolution.reason}`);
    // iOS hands the request to a translationTask host; here the session (NllbSession) is called directly.
    // Without a session this is the explicit capability failure, without a 45s hang.
    Promise.resolve().then(async (): Promise<void> => {
      if (this.pendingRequest?.id === requestID) { await this.processPendingRequest(this.session); }
    });
    return result;
  }

  async processPendingRequest(session?: RecoveryTranslationSession): Promise<void> {
    const request: PendingRequest | undefined = this.pendingRequest;
    const cancellation: RecoveryCancellation | undefined = this.pendingCancellation;
    if (request === undefined || cancellation === undefined || this.processingRequests.has(request.id)) { return; }
    this.processingRequests.add(request.id);
    const task: Promise<void> = this.runPendingRequest(request, cancellation, session);
    this.processingTasks.push(task);
    try { await task; } finally {
      this.processingRequests.delete(request.id);
      this.processingTasks = this.processingTasks.filter((entry: Promise<void>): boolean => entry !== task);
    }
  }

  private async runPendingRequest(request: PendingRequest, cancellation: RecoveryCancellation,
    session?: RecoveryTranslationSession): Promise<void> {
    this.log('request-started');
    try {
      cancellation.check();
      if (session === undefined) { throw new RecoveryPlatformUnavailableError(); }
      const availability: RecoveryLanguageAvailability = session.availability;
      const targetLanguage: string | undefined = this.localeLanguage(request.targetLanguage);
      let status: RecoveryAvailabilityStatus;
      try {
        status = await this.resolvePairAvailabilityStatus(availability, request, targetLanguage, cancellation);
      } catch (error) {
        if (!this.isTranslationServiceConnectionError(error as Error)) { throw error; }
        request.onDiagnosticEvent?.('translation-framework-recovery: transient-service-connection-error stage=availability retry=1');
        await this.retryDelay(cancellation);
        status = await this.resolvePairAvailabilityStatus(availability, request, targetLanguage, cancellation);
      }
      this.log(`availability=${this.describe(status)}`);
      if (status === RecoveryAvailabilityStatus.UNSUPPORTED) {
        request.onDiagnosticEvent?.('translation-framework-recovery: unsupported-preflight-retry=1');
        this.log('unsupported-preflight-retry=1');
        await this.retryDelay(cancellation);
        try {
          status = await this.resolvePairAvailabilityStatus(availability, request, targetLanguage, cancellation);
          this.log(`availability(retry)=${this.describe(status)}`);
        } catch (error) {
          cancellation.check();
          if (this.isTranslationServiceConnectionError(error as Error)) {
            request.onDiagnosticEvent?.('translation-framework-recovery: transient-service-connection-error stage=availability(retry)');
            this.log('availability(retry)-connection-error');
          }
        }
      }
      if (status === RecoveryAvailabilityStatus.UNSUPPORTED) {
        this.log('unsupported-language-pairing');
        const kind: MissingLanguageKind | undefined = await this.diagnoseMissingLanguageKind(
          request.sourceLanguage, request.targetLanguage, request.sourceText, availability, cancellation);
        if (kind !== undefined) {
          request.onDiagnosticEvent?.(`translation-framework-recovery:failure-kind=${kind}`);
          this.log(`failure-kind=${kind}`);
        }
        this.finishPendingRequest(undefined, request.id);
        return;
      }
      let translated: string;
      try {
        this.log('prewarming-session');
        await this.performWithTimeout('prepare', (callCancellation: RecoveryCancellation): Promise<void> => session.prepareTranslation(callCancellation), cancellation);
        this.log('prepare-finished');
        translated = await this.performWithTimeout('translate', (callCancellation: RecoveryCancellation): Promise<string> =>
          this.translatePreservingSeparators(request.sourceText, session, request.onDiagnosticEvent, callCancellation), cancellation);
      } catch (error) {
        cancellation.check();
        const failure: Error = error as Error;
        if (this.isTranslationTimeoutError(failure)) {
          const stage: string = this.timeoutStage(failure);
          request.onDiagnosticEvent?.(`translation-framework-recovery: timeout stage=${stage} retry=1`);
          this.log(`timeout stage=${stage}`);
          await this.retryDelay(cancellation);
          translated = await this.performWithTimeout('translate(retry)', (callCancellation: RecoveryCancellation): Promise<string> =>
            this.translatePreservingSeparators(request.sourceText, session, request.onDiagnosticEvent, callCancellation), cancellation);
        } else if (this.isTranslationServiceConnectionError(failure)) {
          request.onDiagnosticEvent?.('translation-framework-recovery: transient-service-connection-error stage=translate retry=1');
          await this.retryDelay(cancellation);
          this.log('preparing-download-or-consent(retry)');
          await this.performWithTimeout('prepare(retry)', (callCancellation: RecoveryCancellation): Promise<void> => session.prepareTranslation(callCancellation), cancellation);
          this.log('prepare-finished(retry)');
          translated = await this.performWithTimeout('translate(retry)', (callCancellation: RecoveryCancellation): Promise<string> =>
            this.translatePreservingSeparators(request.sourceText, session, request.onDiagnosticEvent, callCancellation), cancellation);
        } else { throw error; }
      }
      cancellation.check();
      const resolved: string | undefined = this.normalizedLanguageIdentifier(request.resolvedSourceLanguageCode);
      if (this.pendingRequest?.id === request.id && resolved !== undefined && this.baseLanguageCode(resolved) !== 'und') {
        this.lastSuccessfulSourceLanguageCode = resolved;
      }
      this.log(`request-finished chars=${translated.length}`);
      this.finishPendingRequest(translated.length === 0 ? undefined : translated, request.id);
    } catch (error) {
      const failure: Error = error as Error;
      if (failure instanceof RecoveryCancelledError || cancellation.cancelled) {
        this.log('cancelled');
      } else if (failure instanceof RecoveryPlatformUnavailableError) {
        request.onDiagnosticEvent?.('translation-framework-recovery:failure-kind=platform_unavailable');
        request.onDiagnosticEvent?.(failure.message);
        this.log(failure.message);
      } else {
        let kind: MissingLanguageKind | undefined;
        try {
          kind = await this.classifyFailureKind(failure, request, session?.availability, cancellation);
          if (kind === undefined && session !== undefined) {
            kind = await this.diagnoseMissingLanguageKind(request.sourceLanguage, request.targetLanguage,
              request.sourceText, session.availability, cancellation);
          }
        } catch (diagnosticError) {
          this.log(`failure-diagnosis: ${(diagnosticError as Error).message}`);
        }
        if (!cancellation.cancelled && kind !== undefined) {
          request.onDiagnosticEvent?.(`translation-framework-recovery:failure-kind=${kind}`);
          this.log(`failure-kind=${kind}`);
        }
        this.log(`failed: ${failure.message}`);
      }
      this.finishPendingRequest(undefined, request.id);
    }
  }

  clearPendingRecoveryState(): void {
    if (this.pendingRequest !== undefined || this.configuration !== undefined) { this.log('clear-pending-recovery-state'); }
    this.finishPendingRequest(undefined);
    this.currentRequestGeneration = util.generateRandomUUID();
  }

  async drainPendingRecovery(): Promise<void> {
    await Promise.all(this.processingTasks.slice());
  }

  private finishPendingRequest(translatedText: string | undefined, requestID?: string): void {
    // A timed-out or cancelled request must never resume the next request's continuation.
    if (requestID !== undefined && this.pendingRequest?.id !== requestID) { return; }
    if (this.pendingRequestWatchdogTask !== undefined) { clearTimeout(this.pendingRequestWatchdogTask); }
    this.pendingRequestWatchdogTask = undefined;
    const continuation: ((value: string | undefined) => void) | undefined = this.pendingContinuation;
    const cancellation: RecoveryCancellation | undefined = this.pendingCancellation;
    this.pendingContinuation = undefined;
    this.pendingCancellation = undefined;
    this.currentConfiguration = undefined;
    this.pendingRequest = undefined;
    cancellation?.cancel();
    continuation?.(translatedText);
  }

  private async translatePreservingSeparators(text: string, session: RecoveryTranslationSession,
    onDiagnosticEvent?: (message: string) => void, cancellation: RecoveryCancellation = new RecoveryCancellation()): Promise<string> {
    const chunks: RecoveryChunk[] = this.splitIntoRecoveryChunks(text);
    const requests: RecoveryTranslationRequest[] = [];
    for (let index: number = 0; index < chunks.length; index++) {
      if (chunks[index].kind === RecoveryChunkKind.TEXT) {
        const request: RecoveryTranslationRequest = { sourceText: chunks[index].value, clientIdentifier: String(index) };
        requests.push(request);
      }
    }
    if (requests.length === 0) { return text; }
    if (TranslationFrameworkUnsafeRecoveryController.verboseLoggingEnabled) {
      onDiagnosticEvent?.(`verbose tf-recovery-input chars=${text.length} chunks=${requests.length} source=${TranslationFrameworkUnsafeRecoveryController.sanitizedForLog(text) ?? '(empty)'}`);
    }
    cancellation.check();
    const responses: RecoveryTranslationResponse[] = await session.translations(requests, cancellation);
    cancellation.check();
    const translatedByIdentifier: Map<string, string> = new Map<string, string>();
    for (const response of responses) {
      if (response.clientIdentifier === undefined) { continue; }
      if (translatedByIdentifier.has(response.clientIdentifier)) { throw new Error('Duplicate recovery response identifier'); }
      translatedByIdentifier.set(response.clientIdentifier, response.targetText);
    }
    let reconstructed: string = '';
    let missingTextChunkCount: number = 0;
    for (let index: number = 0; index < chunks.length; index++) {
      const chunk: RecoveryChunk = chunks[index];
      if (chunk.kind === RecoveryChunkKind.SEPARATOR) { reconstructed += chunk.value; } else {
        const translated: string | undefined = translatedByIdentifier.get(String(index));
        if (translated === undefined) { missingTextChunkCount++; }
        reconstructed += translated ?? chunk.value;
      }
    }
    if (missingTextChunkCount > 0) {
      onDiagnosticEvent?.(`translation-framework-recovery:source-fallback-inserted chunks=${missingTextChunkCount}`);
    }
    if (TranslationFrameworkUnsafeRecoveryController.verboseLoggingEnabled) {
      onDiagnosticEvent?.(`verbose tf-recovery-output chars=${reconstructed.length} output=${TranslationFrameworkUnsafeRecoveryController.sanitizedForLog(reconstructed) ?? '(empty)'}`);
    }
    return reconstructed;
  }

  private splitIntoRecoveryChunks(text: string): RecoveryChunk[] {
    const chunks: RecoveryChunk[] = [];
    const regex: RegExp = /\n+/g;
    let cursor: number = 0;
    let match: RegExpExecArray | null = regex.exec(text);
    while (match !== null) {
      if (cursor < match.index) {
        const chunk: RecoveryChunk = { kind: RecoveryChunkKind.TEXT, value: text.slice(cursor, match.index) };
        chunks.push(chunk);
      }
      const separator: RecoveryChunk = { kind: RecoveryChunkKind.SEPARATOR, value: match[0] };
      chunks.push(separator);
      cursor = match.index + match[0].length;
      match = regex.exec(text);
    }
    if (cursor < text.length) {
      const chunk: RecoveryChunk = { kind: RecoveryChunkKind.TEXT, value: text.slice(cursor) };
      chunks.push(chunk);
    }
    return chunks;
  }

  private static sanitizedForLog(text?: string): string | undefined {
    if (text === undefined) { return undefined; }
    const compact: string = text.replace(/\n/g, '\\n').replace(/\r/g, '\\r').trim();
    if (compact.length === 0) { return undefined; }
    // shortcut: diagnostic truncation counts code points, use grapheme segmentation if exact log lengths become required.
    const characters: string[] = Array.from(compact);
    if (characters.length <= 1500) { return compact; }
    return `${characters.slice(0, 1000).join('')}...(truncated ${characters.length - 1350} chars)...${characters.slice(-350).join('')}`;
  }

  private static get verboseLoggingEnabled(): boolean {
    return TranslationFrameworkUnsafeRecoveryController.preferencesStore?.getSync('developerVerboseModeEnabled', false) === true;
  }

  private localeLanguage(code: string): string | undefined {
    const trimmed: string = code.trim();
    return trimmed.length === 0 || trimmed.toLowerCase() === 'und' ? undefined :
      this.canonicalTranslationFrameworkLanguageIdentifier(trimmed);
  }

  private canonicalTranslationFrameworkLanguageIdentifier(rawCode: string): string {
    const normalized: string = rawCode.trim().replace(/_/g, '-').toLowerCase();
    if (normalized === 'en') { return 'en-US'; }
    if (normalized === 'en-uk') { return 'en-GB'; }
    if (['zh', 'zh-cn', 'zh-sg', 'zh-ch', 'zh-hans'].includes(normalized)) { return 'zh-CN'; }
    if (['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].includes(normalized)) { return 'zh-TW'; }
    return rawCode.trim();
  }

  private describe(status: RecoveryAvailabilityStatus): string {
    switch (status) {
      case RecoveryAvailabilityStatus.INSTALLED: return 'installed';
      case RecoveryAvailabilityStatus.SUPPORTED: return 'supported';
      case RecoveryAvailabilityStatus.UNSUPPORTED: return 'unsupported';
      default: return 'unknown';
    }
  }

  private async diagnoseMissingLanguageKind(sourceLanguage: string, targetLanguage: string, sourceText: string,
    availability: RecoveryLanguageAvailability, cancellation: RecoveryCancellation): Promise<MissingLanguageKind | undefined> {
    const target: string | undefined = this.localeLanguage(targetLanguage);
    const source: string | undefined = this.localeLanguage(sourceLanguage);
    let targetStatus: RecoveryAvailabilityStatus | undefined;
    if (target !== undefined) {
      targetStatus = await this.performWithTimeout('diagnose-target', (callCancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus> =>
        availability.status(target, undefined, callCancellation), cancellation);
    }
    let sourceStatus: RecoveryAvailabilityStatus | undefined;
    if (source !== undefined) {
      sourceStatus = await this.performWithTimeout('diagnose-source', (callCancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus> =>
        availability.status(source, undefined, callCancellation), cancellation);
    } else {
      try {
        sourceStatus = await this.performWithTimeout('diagnose-source-text', (callCancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus> =>
          availability.statusForText(sourceText, undefined, callCancellation), cancellation);
      } catch (error) { cancellation.check(); }
    }
    const sourceMissing: boolean = sourceStatus !== undefined && sourceStatus !== RecoveryAvailabilityStatus.INSTALLED;
    const targetMissing: boolean = targetStatus !== undefined && targetStatus !== RecoveryAvailabilityStatus.INSTALLED;
    if (sourceMissing && targetMissing) { return MissingLanguageKind.SOURCE_AND_TARGET; }
    if (sourceMissing) { return MissingLanguageKind.SOURCE; }
    if (targetMissing) { return MissingLanguageKind.TARGET; }
    return MissingLanguageKind.UNSUPPORTED_PAIR;
  }

  private async classifyFailureKind(error: Error, request: PendingRequest, availability: RecoveryLanguageAvailability | undefined,
    cancellation: RecoveryCancellation): Promise<MissingLanguageKind | undefined> {
    if (!(error instanceof RecoveryTranslationError)) { return undefined; }
    if (error.kind === RecoveryTranslationErrorKind.UNSUPPORTED_SOURCE_LANGUAGE) { return MissingLanguageKind.SOURCE; }
    if (error.kind === RecoveryTranslationErrorKind.UNSUPPORTED_TARGET_LANGUAGE) { return MissingLanguageKind.TARGET; }
    if (availability !== undefined && (error.kind === RecoveryTranslationErrorKind.UNSUPPORTED_LANGUAGE_PAIRING ||
      error.kind === RecoveryTranslationErrorKind.NOT_INSTALLED)) {
      return this.diagnoseMissingLanguageKind(request.sourceLanguage, request.targetLanguage, request.sourceText,
        availability, cancellation);
    }
    return undefined;
  }

  private isTranslationServiceConnectionError(error: Error): boolean {
    let debugDescription: string = '';
    if (error instanceof RecoveryTranslationError) {
      if (error.domain === 'NSCocoaErrorDomain' && error.code === 4097) { return true; }
      debugDescription = error.debugDescription;
    }
    const message: string = `${debugDescription} ${error.message}`.toLowerCase();
    return message.includes('com.apple.translation.text') || message.includes('connection to service') || message.includes('translationd');
  }

  private isTranslationTimeoutError(error: Error): boolean { return error instanceof RecoveryTimeoutError; }
  private timeoutStage(error: Error): string { return error instanceof RecoveryTimeoutError ? error.stage : 'unknown'; }

  private async performWithTimeout<T>(stage: string, operation: (callCancellation: RecoveryCancellation) => Promise<T>,
    cancellation: RecoveryCancellation): Promise<T> {
    cancellation.check();
    const callCancellation: RecoveryCancellation = new RecoveryCancellation();
    let timer: number | undefined;
    let onCancel: () => void = (): void => { cancellation.check(); };
    const interrupted: Promise<T> = new Promise<T>((resolve, reject): void => {
      timer = setTimeout((): void => {
        reject(new RecoveryTimeoutError(stage));
        callCancellation.cancel();
      },
        TranslationFrameworkUnsafeRecoveryController.TRANSLATION_CALL_TIMEOUT_NANOSECONDS / 1000000);
      onCancel = (): void => { callCancellation.cancel(); reject(new RecoveryCancelledError()); };
      cancellation.addListener(onCancel);
    });
    try {
      const result: T = await Promise.race([operation(callCancellation), interrupted]);
      cancellation.check();
      return result;
    } finally {
      if (timer !== undefined) { clearTimeout(timer); }
      cancellation.removeListener(onCancel);
      callCancellation.cancel();
    }
  }

  private async retryDelay(cancellation: RecoveryCancellation): Promise<void> {
    let timer: number | undefined;
    let onCancel: () => void = (): void => { cancellation.check(); };
    try {
      await new Promise<void>((resolve, reject): void => {
        timer = setTimeout(resolve, 250);
        onCancel = (): void => reject(new RecoveryCancelledError());
        cancellation.addListener(onCancel);
      });
      cancellation.check();
    } finally {
      if (timer !== undefined) { clearTimeout(timer); }
      cancellation.removeListener(onCancel);
    }
  }

  private async resolvePairAvailabilityStatus(availability: RecoveryLanguageAvailability, request: PendingRequest,
    targetLanguage: string | undefined, cancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus> {
    const effectiveSourceLanguageCode: string = request.resolvedSourceLanguageCode ?? request.sourceLanguage;
    const sourceLanguage: string | undefined = this.localeLanguage(effectiveSourceLanguageCode);
    const status: RecoveryAvailabilityStatus = sourceLanguage !== undefined ?
      await this.performWithTimeout('availability', (callCancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus> =>
        availability.status(sourceLanguage, targetLanguage, callCancellation), cancellation) :
      await this.performWithTimeout('availability', (callCancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus> =>
        availability.statusForText(request.sourceText, targetLanguage, callCancellation), cancellation);
    request.onDiagnosticEvent?.(`translation-framework-recovery: availability-check=${sourceLanguage !== undefined ? 'from' : 'from-text'} source=${sourceLanguage !== undefined ? effectiveSourceLanguageCode : request.sourceLanguage} target=${request.targetLanguage} status=${this.describe(status)}`);
    return status;
  }

  private resolveSourceLanguageCode(requestedSourceLanguage: string, targetLanguage: string): SourceLanguageResolution {
    const requested: string | undefined = this.normalizedLanguageIdentifier(requestedSourceLanguage);
    if (requested !== undefined && this.baseLanguageCode(requested) !== 'und') {
      const result: SourceLanguageResolution = {
        code: this.alignedGenericSourceLanguageCode(requested, targetLanguage), reason: SourceLanguageResolutionReason.REQUESTED
      };
      return result;
    }
    const previous: string | undefined = this.normalizedLanguageIdentifier(this.lastSuccessfulSourceLanguageCode);
    if (previous !== undefined && this.baseLanguageCode(previous) !== 'und') {
      const result: SourceLanguageResolution = {
        code: this.alignedGenericSourceLanguageCode(previous, targetLanguage), reason: SourceLanguageResolutionReason.FALLBACK_PREVIOUS_SUCCESS
      };
      return result;
    }
    const result: SourceLanguageResolution = { reason: SourceLanguageResolutionReason.UNDETERMINED };
    return result;
  }

  private normalizedLanguageIdentifier(code?: string): string | undefined {
    const trimmed: string | undefined = code?.trim().toLowerCase();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed.replace(/_/g, '-');
  }

  private baseLanguageCode(identifier: string): string { return identifier.split('-')[0] || identifier; }

  private alignedGenericSourceLanguageCode(sourceLanguage: string, targetLanguage: string): string {
    const source: string = sourceLanguage.toLowerCase();
    const target: string = this.canonicalTranslationFrameworkLanguageIdentifier(targetLanguage).toLowerCase();
    if (source === 'en') { return target === 'en-us' ? 'en-GB' : 'en-US'; }
    if (this.baseLanguageCode(source) === 'zh') {
      if (target === 'zh-tw') { return 'zh-CN'; }
      if (target === 'zh-cn' || target === 'zh-ch') { return 'zh-TW'; }
      const canonical: string = this.canonicalTranslationFrameworkLanguageIdentifier(sourceLanguage);
      return ['zh-cn', 'zh-tw'].includes(canonical.toLowerCase()) ? canonical : 'zh-CN';
    }
    return sourceLanguage;
  }
}
