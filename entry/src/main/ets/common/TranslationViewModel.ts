import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { i18n } from '@kit.LocalizationKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  TranslationExperimentMode, TRANSLATION_EXPERIMENT_MODES, experimentModeDisplayName,
  TranslationRequest, TranslationOutput, SegmentOutput, TextSegment, PreprocessTrace,
  ProtectedToken, GlossaryMatch, GlossaryEntry, AmbiguityHint, TargetLanguageOption,
  TargetLanguageLabelStyle, StatusNotice, StatusNoticeKind, StatusNoticeStyle, UserAlert,
  TranslationStatus, TranslationStatusKind, TFMenuAvailabilityStatus, ClutchSegmentBinding, NSRange
} from '../model/TranslationModels';
import { AppleIntelligenceLanguageCatalog } from './LanguageCatalog';
import { SharedImportStore } from './SharedImportStore';
import { DeterministicPreprocessEngine, HeuristicLanguageDetector } from './PreprocessEngine';
import { IOSAdaptiveTranslationEnginePolicy, IOSPreferredTranslationEngineMode } from './EnginePolicies';
import { TranslationOrchestrator, TranslationPipelineError } from './TranslationOrchestrator';
import { NllbModel, NllbSession } from './NllbSession';
import { FoundationModelsTranslationEngine, TranslationFrameworkPrimaryTranslationEngine,
  TranslationCancelledError, TranslationPlatformUnavailableError } from './TranslationEngines';
import { TranslationFrameworkUnsafeRecoveryController, RecoveryTranslationSession, RecoveryCancellation,
  RecoveryAvailabilityStatus } from './UnsafeRecovery';

export { StatusNotice, StatusNoticeKind, UserAlert, TranslationStatus,
  TFMenuAvailabilityStatus } from '../model/TranslationModels';

export enum AppStateKey {
  TARGET_LANGUAGE = 'appState.targetLanguage',
  EXPERIMENT_MODE = 'appState.experimentMode',
  RECENT_TARGET_LANGUAGES = 'appState.recentTargetLanguages'
}
export enum LanguageRole { SOURCE = 'source', TARGET = 'target' }
export interface TFMenuPreparationConfiguration { source?: string; target: string; }
export type TranslationStateObserver = (model: TranslationViewModel) => void;
interface LanguagePair { source: string; target: string; }

class TranslationTask {
  value?: Promise<void>;
  readonly cancellation: Promise<TranslationOutput>;
  private rejectCancellation?: (reason: Error) => void;
  constructor() {
    this.cancellation = new Promise<TranslationOutput>((resolve, reject) => {
      this.rejectCancellation = reject;
    });
    this.cancellation.catch((error: Error) => { return error; });
  }
  cancel(): void { this.rejectCancellation?.(new TranslationCancelledError()); }
}

export class TranslationViewModel {
  private selectedTargetLanguage: string;
  private selectedExperimentMode: TranslationExperimentMode = TranslationExperimentMode.SEGMENTED;
  private sourceText: string = '';
  private glossary: string = '';
  translatedText: string = '';
  segmentOutputs: SegmentOutput[] = [];
  segmentJoinersAfter: string[] = [];
  sourceSegments: TextSegment[] = [];
  sourceTextSnapshotForSegments: string = '';
  traces: PreprocessTrace[] = [];
  protectedTokens: ProtectedToken[] = [];
  glossaryMatches: GlossaryMatch[] = [];
  ambiguityHints: AmbiguityHint[] = [];
  engineName: string = '';
  detectedLanguageCode: string = '';
  aiLanguageSupported: boolean = true;
  isTranslating: boolean = false;
  errorMessage?: string;
  userAlert?: UserAlert;
  developerLogs: string[] = [];
  statusNotices: StatusNotice[] = [];
  status: TranslationStatus = { kind: TranslationStatusKind.READY };
  targetLanguageOptions: TargetLanguageOption[] = [];
  isAppleIntelligenceAvailable: boolean = false;
  usesAppleIntelligenceTranslation: boolean = false;
  tfMenuAvailabilityByTarget: Map<string, TFMenuAvailabilityStatus> = new Map();
  tfMenuUnsupportedHintMessage?: string;
  tfMenuPreparationConfiguration?: TFMenuPreparationConfiguration;
  tfMenuPreparationGeneration: string = util.generateRandomUUID();
  // These macOS-only source members stay inactive on the phone; there is no phone HUD consumer.
  readonly macImportLoadingHUDVisible: boolean = false;
  readonly macImportHUDMessage?: string;
  readonly orchestrator: TranslationOrchestrator;
  readonly iOSEnginePolicy?: IOSAdaptiveTranslationEnginePolicy;
  readonly unsafeRecoveryController?: TranslationFrameworkUnsafeRecoveryController;
  private userDefaults?: preferences.Preferences;
  private context?: common.Context;
  private readonly preferredLanguages: string[];
  private readonly initialOptions: TargetLanguageOption[];
  private recentTargetLanguageCodes: string[] = [];
  private shouldTranslateOnLaunch: boolean = false;
  private shouldActivateAppOnLaunch: boolean = false;
  private partialTranslationsBySegment: Map<number, string> = new Map();
  private partialJoinersAfter: string[] = [];
  private lastHandledIncomingURLKey?: string;
  private lastHandledSharedImportKey?: string;
  private activeTranslationTask?: TranslationTask;
  private activeTranslationToken?: string;
  private pendingTranslationRequestStartedAt?: number;
  private sessionSequenceNumber: number = 0;
  private activeMetricsSessionID?: string;
  private activeMetricsRequestStartedAt?: number;
  private activeMetricsSessionStartedAt?: number;
  private activeMetricsFirstOutputAt?: number;
  private tfMenuAvailabilityTask?: Promise<void>;
  private tfMenuInputRefreshTask?: number;
  private tfMenuPreparationTargetLanguageCode?: string;
  private lastMenuSourceLanguageCode?: string;
  private observers: TranslationStateObserver[] = [];
  private menuGeneration: number = 0;
  private menuCancellation?: RecoveryCancellation;
  private preparationCancellation?: RecoveryCancellation;
  private recoverySession?: RecoveryTranslationSession;
  private autoTranslateImportedText: boolean = false;
  private clutchMode: boolean = true;
  private developerMode: boolean = false;
  private developerVerboseMode: boolean = false;
  private fontScaleLevel: number = 2;
  clutchSelectedSegmentIndex?: number;
  sourceHighlightRange?: NSRange;

  constructor(orchestrator?: TranslationOrchestrator, iOSEnginePolicy?: IOSAdaptiveTranslationEnginePolicy,
    launchInputText?: string, preferredLanguages: string[] = i18n.System.getPreferredLanguageList()) {
    this.preferredLanguages = preferredLanguages;
    this.initialOptions = AppleIntelligenceLanguageCatalog.translationFrameworkLanguageOptions();
    this.selectedTargetLanguage = TranslationViewModel.preferredDefaultTargetLanguageCode(
      this.initialOptions, preferredLanguages) ?? 'en-US';
    if (orchestrator) {
      this.orchestrator = orchestrator;
      this.iOSEnginePolicy = iOSEnginePolicy;
    } else {
      const recovery = new TranslationFrameworkUnsafeRecoveryController();
      const standard = new TranslationFrameworkPrimaryTranslationEngine(recovery);
      const ai = new FoundationModelsTranslationEngine(recovery);
      this.unsafeRecoveryController = recovery;
      this.iOSEnginePolicy = new IOSAdaptiveTranslationEnginePolicy(standard, ai);
      this.orchestrator = new TranslationOrchestrator(new DeterministicPreprocessEngine(), this.iOSEnginePolicy);
    }
    this.refreshEnginePreference();
    this.applyLaunchInputText(launchInputText);
  }

  /** Launch text (iOS process arguments, here the 'launchArguments' Want parameter): fills Source and translates. */
  applyLaunchInputText(launchInputText?: string): void {
    const trimmed = this.normalizedLineEndings(launchInputText ?? '').trim();
    if (trimmed.length > 0) {
      this.sourceText = trimmed;
      this.shouldTranslateOnLaunch = true;
      this.shouldActivateAppOnLaunch = true;
    }
  }

  async initialize(context: common.Context): Promise<void> {
    this.context = context;
    try {
      this.userDefaults = preferences.getPreferencesSync(context, { name: 'zenBabel' });
      this.reloadSettings();
    } catch (error) {
      this.errorMessage = `Could not load saved settings: ${(error as Error).message}`;
      this.appendDeveloperLog(this.errorMessage);
    }
    SharedImportStore.initialize(context);
    this.notifyStateChanged();
    this.orchestrator.initialize(context);
    this.installNllbSessions(context);
    // Pending shared text is imported by the launch intake (ImportService.handleSharedImportIfNeeded), which shows
    // the 'Shared text imported.' toast; as on iOS, importSharedTextIfNeeded() is not called at launch.
    if (this.iOSEnginePolicy) {
      try { await this.iOSEnginePolicy.checkAvailability(); }
      catch (error) { this.appendDeveloperLog(`AI availability failed: ${(error as Error).message}`); }
    }
    this.refreshEnginePreference();
  }

  // V1 roots subscribe and increment a @State revision; a .ts class cannot use @Observed.
  observe(observer: TranslationStateObserver): () => void {
    this.observers.push(observer);
    observer(this);
    return () => { this.observers = this.observers.filter((existing) => existing !== observer); };
  }
  notifyStateChanged(): void { for (const observer of this.observers.slice()) observer(this); }
  get targetLanguage(): string { return this.selectedTargetLanguage; }
  set targetLanguage(value: string) {
    this.selectedTargetLanguage = value;
    this.persistTargetLanguageSelection();
    this.notifyStateChanged();
  }
  get experimentMode(): TranslationExperimentMode { return this.selectedExperimentMode; }
  set experimentMode(value: TranslationExperimentMode) {
    if (!TRANSLATION_EXPERIMENT_MODES.includes(value)) return;
    this.selectedExperimentMode = value;
    this.persistExperimentModeSelection();
    this.notifyStateChanged();
  }
  get inputText(): string { return this.sourceText; }
  set inputText(value: string) {
    const previous = this.sourceText;
    this.sourceText = value;
    this.handleSourceTextEdited(previous, value);
    this.notifyStateChanged();
  }
  get glossaryText(): string { return this.glossary; }
  set glossaryText(value: string) { this.glossary = value; this.notifyStateChanged(); }
  get autoTranslateImportedTextEnabled(): boolean { return this.autoTranslateImportedText; }
  set autoTranslateImportedTextEnabled(value: boolean) {
    this.autoTranslateImportedText = value;
    this.persistSetting('autoTranslateImportedTextEnabled', value);
    this.notifyStateChanged();
  }
  get clutchModeEnabled(): boolean { return this.clutchMode; }
  set clutchModeEnabled(value: boolean) {
    this.clutchMode = value;
    this.persistSetting('clutchModeEnabled', value);
    if (!value) { this.sourceHighlightRange = undefined; this.clutchSelectedSegmentIndex = undefined; }
    this.notifyStateChanged();
  }
  get developerModeEnabled(): boolean { return this.developerMode; }
  set developerModeEnabled(value: boolean) {
    this.developerMode = value;
    this.persistSetting('developerModeEnabled', value);
    this.notifyStateChanged();
  }
  get developerVerboseModeEnabled(): boolean { return this.developerVerboseMode; }
  set developerVerboseModeEnabled(value: boolean) {
    this.developerVerboseMode = value;
    this.persistSetting('developerVerboseModeEnabled', value);
    this.notifyStateChanged();
  }
  get editorFontScaleLevel(): number { return this.fontScaleLevel; }
  set editorFontScaleLevel(value: number) {
    if (!Number.isFinite(value)) return;
    this.fontScaleLevel = Math.min(4, Math.max(0, Math.round(value)));
    this.persistSetting('editorFontScaleLevel', this.fontScaleLevel);
    this.notifyStateChanged();
  }
  get editorFontScaleMultiplier(): number { return [0.8, 0.9, 1, 1.2, 1.4][this.fontScaleLevel]; }
  get editorFontScaleLabel(): string { return ['XS', 'S', 'M', 'L', 'XL'][this.fontScaleLevel]; }
  get canUseCompactOutputReadingMode(): boolean { return false; }
  get developerPanelsVisible(): boolean { return this.developerModeEnabled; }
  targetLanguageMenuLabel(option: TargetLanguageOption): string {
    return option.menuLabel(this.developerModeEnabled,
      this.usesAppleIntelligenceTranslation ? TargetLanguageLabelStyle.AI : TargetLanguageLabelStyle.MACHINE);
  }

  reloadSettings(): void {
    if (!this.userDefaults) return;
    const persistedTargetLanguage = this.userDefaults.getSync(AppStateKey.TARGET_LANGUAGE, '') as string;
    if (this.initialOptions.some((option) => option.code === persistedTargetLanguage)) {
      this.selectedTargetLanguage = persistedTargetLanguage;
    }
    const preferredMode = this.userDefaults.getSync(AppStateKey.EXPERIMENT_MODE, '') as string;
    this.selectedExperimentMode = TRANSLATION_EXPERIMENT_MODES.find((mode) => mode === preferredMode)
      ?? TranslationExperimentMode.SEGMENTED;
    const recent = this.userDefaults.getSync(AppStateKey.RECENT_TARGET_LANGUAGES, []) as string[];
    this.recentTargetLanguageCodes = Array.isArray(recent) ? recent.filter((code) => typeof code === 'string') : [];
    this.autoTranslateImportedText = this.userDefaults.getSync('autoTranslateImportedTextEnabled', false) as boolean;
    this.clutchMode = this.userDefaults.getSync('clutchModeEnabled', true) as boolean;
    this.developerMode = this.userDefaults.getSync('developerModeEnabled', false) as boolean;
    this.developerVerboseMode = this.userDefaults.getSync('developerVerboseModeEnabled', false) as boolean;
    const scale = this.userDefaults.getSync('editorFontScaleLevel', 2) as number;
    this.fontScaleLevel = Number.isInteger(scale) && scale >= 0 && scale <= 4 ? scale : 2;
    if (!this.clutchMode) { this.sourceHighlightRange = undefined; this.clutchSelectedSegmentIndex = undefined; }
    this.pruneRecentTargetLanguageCodes();
    this.refreshEnginePreference();
  }
  private persistSetting(key: string, value: preferences.ValueType): void {
    if (!this.userDefaults) return;
    try {
      this.userDefaults.putSync(key, value);
      this.userDefaults.flush().catch((error: Error) => {
        this.errorMessage = `Could not save settings: ${error.message}`;
        this.appendDeveloperLog(this.errorMessage);
        this.notifyStateChanged();
      });
    } catch (error) {
      this.errorMessage = `Could not save settings: ${(error as Error).message}`;
      this.appendDeveloperLog(this.errorMessage);
      this.notifyStateChanged();
    }
  }
  private persistTargetLanguageSelection(): void {
    if (this.targetLanguage.length > 0) this.persistSetting(AppStateKey.TARGET_LANGUAGE, this.targetLanguage);
  }
  private persistExperimentModeSelection(): void { this.persistSetting(AppStateKey.EXPERIMENT_MODE, this.experimentMode); }
  private persistRecentTargetLanguageSelections(): void {
    this.persistSetting(AppStateKey.RECENT_TARGET_LANGUAGES, this.recentTargetLanguageCodes);
  }
  consumeLaunchActivationRequest(): boolean {
    const activate = this.shouldActivateAppOnLaunch;
    this.shouldActivateAppOnLaunch = false;
    return activate;
  }
  async translateIfNeededOnLaunch(): Promise<void> {
    if (!this.shouldTranslateOnLaunch) return;
    this.shouldTranslateOnLaunch = false;
    await this.translate();
  }
  async handleIncomingURL(url: string): Promise<void> {
    const text = URLLaunchParser.extractText(url);
    if (text !== undefined) await this.handleExternalTriggerText(text, 'url');
  }
  async handleDoubleCopyText(text: string): Promise<void> { await this.handleExternalTriggerText(text, 'double-copy'); }
  private async handleExternalTriggerText(text: string, source: string): Promise<void> {
    const trimmed = this.normalizedLineEndings(text).trim();
    if (trimmed.length === 0) return;
    const key = `${this.targetLanguage}\u001f${this.experimentMode}\u001f${trimmed}`;
    if (key === this.lastHandledIncomingURLKey) return;
    this.lastHandledIncomingURLKey = key;
    this.inputText = trimmed;
    this.appendDeveloperLog(`Incoming ${source} accepted. chars=${trimmed.length}, target=${this.targetLanguage}, mode=${this.experimentMode}`);
    await this.translate();
  }
  async importSharedTextIfNeeded(): Promise<string | undefined> {
    const text = await SharedImportStore.consumePendingText();
    if (text === undefined) return undefined;
    const trimmed = this.normalizedLineEndings(text).trim();
    if (trimmed.length === 0 || this.lastHandledSharedImportKey === trimmed) return undefined;
    this.lastHandledSharedImportKey = trimmed;
    this.handleSourceTextPasted(trimmed);
    this.appendDeveloperLog(`Incoming share-store accepted. chars=${trimmed.length}`);
    if (this.autoTranslateImportedTextEnabled) await this.translate();
    return trimmed;
  }
  refreshEnginePreference(): void {
    this.isAppleIntelligenceAvailable = this.iOSEnginePolicy?.isFoundationModelsAvailable() ?? false;
    this.usesAppleIntelligenceTranslation = this.isAppleIntelligenceAvailable &&
      this.iOSEnginePolicy?.currentPreferredMode() === IOSPreferredTranslationEngineMode.FOUNDATION_MODELS;
    this.targetLanguageOptions = this.usesAppleIntelligenceTranslation
      ? AppleIntelligenceLanguageCatalog.supportedLanguageOptions()
      : AppleIntelligenceLanguageCatalog.translationFrameworkLanguageOptions();
    this.normalizeTargetLanguageSelection();
    this.pruneRecentTargetLanguageCodes();
    this.refreshTFMenuAvailabilityIfNeeded();
    this.notifyStateChanged();
  }
  async switchToAppleIntelligenceTranslation(): Promise<void> {
    if (!this.iOSEnginePolicy) return;
    await this.iOSEnginePolicy.checkAvailability();
    this.iOSEnginePolicy.setPreferredMode(IOSPreferredTranslationEngineMode.FOUNDATION_MODELS);
    this.refreshEnginePreference();
    if (!this.usesAppleIntelligenceTranslation) {
      this.errorMessage = 'AI translation is not available on this device.';
      this.userAlert = this.alertForLocalizedDescription(this.errorMessage);
      this.notifyStateChanged();
    }
  }
  switchToStandardTranslation(): void {
    this.iOSEnginePolicy?.setPreferredMode(IOSPreferredTranslationEngineMode.TRANSLATION_FRAMEWORK);
    this.refreshEnginePreference();
  }
  tfMenuStatus(code: string): TFMenuAvailabilityStatus {
    return this.usesAppleIntelligenceTranslation ? TFMenuAvailabilityStatus.INSTALLED
      : this.tfMenuAvailabilityByTarget.get(code) ?? TFMenuAvailabilityStatus.UNKNOWN;
  }
  tfMenuDownloadMark(code: string): string | undefined {
    return this.tfMenuStatus(code) === TFMenuAvailabilityStatus.SUPPORTED ? '⬇︎' : undefined;
  }
  isTargetLanguageSelectionDisabled(code: string): boolean { return this.tfMenuStatus(code) === TFMenuAvailabilityStatus.UNSUPPORTED; }
  targetLanguageSelectionHelpText(code: string): string | undefined {
    switch (this.tfMenuStatus(code)) {
      case TFMenuAvailabilityStatus.SUPPORTED: return this.localizedDownloadHintText;
      case TFMenuAvailabilityStatus.UNSUPPORTED: return this.unsupportedPairHintText(code);
      default: return undefined;
    }
  }
  selectTargetLanguageFromMenu(code: string): void {
    if (!this.targetLanguageOptions.some((option) => option.code === code)) return;
    const status = this.tfMenuStatus(code);
    if (status === TFMenuAvailabilityStatus.UNSUPPORTED) {
      this.tfMenuUnsupportedHintMessage = this.unsupportedPairHintText(code);
    } else {
      this.targetLanguage = code;
      this.recordRecentTargetLanguageSelection(code);
      this.tfMenuUnsupportedHintMessage = this.unsupportedPairHintTextIfNeeded();
      if (status === TFMenuAvailabilityStatus.SUPPORTED) this.requestTFLanguagePackDownload(code);
    }
    this.notifyStateChanged();
  }
  recentTargetLanguageOptions(limit: number = 4): TargetLanguageOption[] {
    if (limit <= 0) return [];
    const codes = this.recentTargetLanguageCodes.slice(0, limit);
    const result: TargetLanguageOption[] = [];
    for (const code of codes) {
      const option = this.targetLanguageOptions.find((candidate) => candidate.code === code);
      if (option) result.push(option);
    }
    return result;
  }
  remainingTargetLanguageOptionsExcludingRecent(limit: number = 4): TargetLanguageOption[] {
    const recent = this.recentTargetLanguageOptions(limit).map((option) => option.code);
    return this.targetLanguageOptions.filter((option) => !recent.includes(option.code));
  }
  private normalizeTargetLanguageSelection(): void {
    if (this.targetLanguageOptions.length === 0) return;
    if (this.targetLanguageOptions.some((option) => option.code === this.targetLanguage)) {
      this.persistTargetLanguageSelection();
    } else {
      this.targetLanguage = TranslationViewModel.preferredDefaultTargetLanguageCode(
        this.targetLanguageOptions, this.preferredLanguages) ?? this.targetLanguageOptions[0].code;
    }
  }
  private recordRecentTargetLanguageSelection(code: string): void {
    if (code.length === 0) return;
    this.recentTargetLanguageCodes = [code].concat(this.recentTargetLanguageCodes.filter((recent) => recent !== code)).slice(0, 8);
    this.persistRecentTargetLanguageSelections();
  }
  private pruneRecentTargetLanguageCodes(): void {
    if (this.recentTargetLanguageCodes.length === 0) return;
    this.recentTargetLanguageCodes = this.recentTargetLanguageCodes.filter((code) =>
      this.targetLanguageOptions.some((option) => option.code === code));
    this.persistRecentTargetLanguageSelections();
  }
  handleSourceTextEdited(previousText: string, currentText: string): void {
    if (previousText !== currentText) this.scheduleTFMenuAvailabilityRefresh();
  }
  handleSourceTextPasted(text: string): void {
    this.inputText = this.normalizedLineEndings(text);
    this.refreshLanguageMenuSourceLanguage();
  }
  refreshLanguageMenuSourceLanguage(): void {
    this.sourceText = this.normalizedLineEndings(this.inputText);
    if (this.inputText.trim().length === 0) {
      this.detectedLanguageCode = '';
      this.refreshTFMenuAvailabilityIfNeeded();
      this.notifyStateChanged();
      return;
    }
    const detection = HeuristicLanguageDetector.detectLanguage(this.inputText);
    const detected = TranslationViewModel.normalizedLanguageCode(detection.detectedLanguageCode);
    if (detected.length > 0 && detected !== 'und' &&
      detected === TranslationViewModel.normalizedLanguageCode(this.targetLanguage) &&
      this.lastMenuSourceLanguageCode && this.lastMenuSourceLanguageCode !== detected) {
      const fallback = this.targetLanguageOptions.find((option) =>
        TranslationViewModel.normalizedLanguageCode(option.code) === this.lastMenuSourceLanguageCode);
      if (fallback) this.targetLanguage = fallback.code;
    }
    this.detectedLanguageCode = detection.detectedLanguageCode;
    if (detected.length > 0 && detected !== 'und') this.lastMenuSourceLanguageCode = detected;
    this.refreshTFMenuAvailabilityIfNeeded();
    this.notifyStateChanged();
  }
  clearSourceTextAndResetLanguageState(): void {
    this.resetTranslationRuntimeStateForClear();
    this.sourceText = '';
    this.clearTranslationOutput();
    this.status = { kind: TranslationStatusKind.READY };
    this.tfMenuUnsupportedHintMessage = undefined;
    this.lastMenuSourceLanguageCode = undefined;
    this.refreshTFMenuAvailabilityIfNeeded();
    this.notifyStateChanged();
  }
  private clearTranslationOutput(): void {
    this.translatedText = '';
    this.segmentOutputs = [];
    this.segmentJoinersAfter = [];
    this.sourceSegments = [];
    this.sourceTextSnapshotForSegments = '';
    this.traces = [];
    this.protectedTokens = [];
    this.glossaryMatches = [];
    this.ambiguityHints = [];
    this.engineName = '';
    this.detectedLanguageCode = '';
    this.aiLanguageSupported = true;
    this.errorMessage = undefined;
    this.userAlert = undefined;
    this.statusNotices = [];
    this.sourceHighlightRange = undefined;
    this.clutchSelectedSegmentIndex = undefined;
  }
  async translate(): Promise<void> {
    this.pendingTranslationRequestStartedAt = Date.now();
    await this.runManagedTranslation();
  }
  stopTranslation(): void {
    this.activeTranslationTask?.cancel();
    this.orchestrator.cancelTranslation();
    this.activeTranslationTask = undefined;
    this.activeTranslationToken = undefined;
    this.isTranslating = false;
    this.status = { kind: TranslationStatusKind.STOPPED };
    this.resetSessionMetricsState();
    this.appendDeveloperLog('Translation stopped by user. Native work may still be finishing in the background.');
    this.notifyStateChanged();
  }
  private async runManagedTranslation(): Promise<void> {
    if (this.activeTranslationTask) {
      this.activeTranslationTask.cancel();
      this.orchestrator.cancelTranslation();
    }
    const token = util.generateRandomUUID();
    const task = new TranslationTask();
    this.activeTranslationToken = token;
    this.activeTranslationTask = task;
    task.value = this.performTranslation(token, task.cancellation);
    await task.value;
    if (this.activeTranslationToken === token) {
      this.activeTranslationTask = undefined;
      this.activeTranslationToken = undefined;
    }
  }
  private async performTranslation(token: string, cancellation: Promise<TranslationOutput>): Promise<void> {
    this.sourceText = this.normalizedLineEndings(this.inputText);
    const request = new TranslationRequest('und', this.targetLanguage, this.inputText,
      this.parseGlossary(this.glossaryText), this.preferredLanguages, this.experimentMode,
      this.usesAppleIntelligenceTranslation);
    if (request.text.trim().length === 0) {
      this.clearTranslationOutput();
      this.status = { kind: TranslationStatusKind.READY };
      this.isTranslating = false;
      this.pendingTranslationRequestStartedAt = undefined;
      this.resetSessionMetricsState();
      this.refreshTFMenuAvailabilityIfNeeded();
      this.notifyStateChanged();
      return;
    }
    this.sessionSequenceNumber += 1;
    this.activeMetricsSessionID = `S${this.sessionSequenceNumber}`;
    this.activeMetricsRequestStartedAt = this.pendingTranslationRequestStartedAt ?? Date.now();
    this.activeMetricsSessionStartedAt = undefined;
    this.activeMetricsFirstOutputAt = undefined;
    this.pendingTranslationRequestStartedAt = undefined;
    this.clearTranslationOutput();
    this.partialTranslationsBySegment.clear();
    this.partialJoinersAfter = [];
    this.status = { kind: TranslationStatusKind.PROCESSING, mode: request.experimentMode };
    this.isTranslating = true;
    this.notifyStateChanged();
    try {
      const output = await Promise.race([cancellation, this.orchestrator.translate(request,
        (segmentCount: number, sentenceCount: number, detected: string, target: string, kinds: string) => {
          if (this.activeTranslationToken !== token) return;
          this.appendSessionLog(`session-start: segments=${segmentCount}, tokenizer-sentences=${sentenceCount}, detected=${detected || 'none'}, target=${target}, kinds={${kinds}}`);
          this.recordSessionStarted();
          this.notifyStateChanged();
        },
        (message: string) => {
          if (this.activeTranslationToken !== token) return;
          if (!message.startsWith('verbose ') || this.developerVerboseModeEnabled) this.appendSessionLog(message);
          this.notifyStateChanged();
        },
        (index: number, partial: string, joiners: string[]) => {
          if (this.activeTranslationToken !== token) return;
          this.recordFirstOutputIfNeeded();
          this.partialTranslationsBySegment.set(index, partial);
          this.partialJoinersAfter = joiners;
          this.translatedText = this.reconstructPartialTranslatedText();
          const total = Math.max(1, joiners.length);
          this.status = { kind: TranslationStatusKind.TRANSLATING, current: Math.min(total, Math.max(1, index + 1)), total: total };
          this.notifyStateChanged();
        },
        () => {
          if (this.activeTranslationToken === token) this.recordSessionFinished();
        })]);
      if (this.activeTranslationToken !== token) return;
      this.recordFirstOutputIfNeeded();
      this.translatedText = output.translatedText;
      this.segmentOutputs = output.segmentOutputs;
      this.segmentJoinersAfter = output.analysis.input.segmentJoinersAfter;
      this.sourceSegments = output.analysis.input.segments;
      this.sourceTextSnapshotForSegments = output.analysis.input.originalText;
      this.traces = output.analysis.traces;
      this.protectedTokens = output.analysis.input.protectedTokens;
      this.glossaryMatches = output.analysis.input.glossaryMatches;
      this.ambiguityHints = output.analysis.input.ambiguityHints;
      this.engineName = output.analysis.engineName;
      this.detectedLanguageCode = output.analysis.input.detectedLanguageCode ?? '';
      this.aiLanguageSupported = output.analysis.input.isDetectedLanguageSupportedByAppleIntelligence;
      this.errorMessage = undefined;
      this.userAlert = undefined;
      this.statusNotices = this.makeStatusNotices(output, request);
      this.status = { kind: TranslationStatusKind.COMPLETED };
      this.refreshTFMenuAvailabilityIfNeeded();
    } catch (error) {
      if (this.activeTranslationToken !== token) return;
      if (error instanceof TranslationCancelledError) {
        this.status = { kind: TranslationStatusKind.STOPPED };
        this.statusNotices = [];
        this.appendSessionLog('translation-cancelled');
      } else {
        if (error instanceof TranslationPipelineError) {
          this.detectedLanguageCode = error.detectedLanguageCode ?? '';
          this.aiLanguageSupported = false;
          this.refreshTFMenuAvailabilityIfNeeded();
        }
        this.userAlert = this.alertForError(error as Error);
        this.errorMessage = this.userAlert?.inlineMessage ?? (error as Error).message;
        this.statusNotices = [];
        this.status = { kind: TranslationStatusKind.READY };
        this.appendSessionLog(this.detailedErrorLog(error as Error));
      }
    } finally {
      if (this.activeTranslationToken === token) {
        this.isTranslating = false;
        this.resetSessionMetricsState();
        this.notifyStateChanged();
      }
    }
  }
  get statusText(): string {
    switch (this.status.kind) {
      case TranslationStatusKind.READY: return 'Ready';
      case TranslationStatusKind.PROCESSING: return `Processing (${experimentModeDisplayName(this.status.mode ?? this.experimentMode)})`;
      case TranslationStatusKind.TRANSLATING: return `Translating ${this.status.current}/${this.status.total}`;
      case TranslationStatusKind.STOPPED: return 'Stopped';
      case TranslationStatusKind.COMPLETED: return 'Completed';
    }
  }
  get developerLogsText(): string { return this.developerLogs.join('\n'); }
  clearDeveloperLogs(): void { this.developerLogs = []; this.notifyStateChanged(); }
  dismissUserAlert(): void { this.userAlert = undefined; this.notifyStateChanged(); }
  private parseGlossary(raw: string): GlossaryEntry[] {
    const result: GlossaryEntry[] = [];
    for (const line of raw.split('\n')) {
      const separator = line.indexOf('=');
      if (separator < 0) continue;
      const source = line.slice(0, separator).trim();
      const target = line.slice(separator + 1).trim();
      if (source.length > 0 && target.length > 0) result.push({ source: source, target: target });
    }
    return result;
  }
  private reconstructPartialTranslatedText(): string {
    const indexes = Array.from(this.partialTranslationsBySegment.keys()).sort((a, b) => a - b);
    const texts = indexes.map((index) => this.partialTranslationsBySegment.get(index) ?? '');
    return this.partialJoinersAfter.length >= texts.length
      ? texts.map((text, index) => text + this.normalizedJoiner(this.partialJoinersAfter[index], text)).join('')
      : texts.join(' ');
  }
  private normalizedJoiner(joiner: string, translated: string): string {
    return /[.!?。！？]$/.test(translated.trim()) ? joiner.replace(/^[.!?。！？]+/, '') : joiner;
  }
  private appendDeveloperLog(message: string): void {
    this.developerLogs = this.developerLogs.concat(`[${new Date().toISOString()}] ${message}`).slice(-300);
  }
  private appendSessionLog(message: string): void {
    this.appendDeveloperLog(this.activeMetricsSessionID ? `[${this.activeMetricsSessionID}] ${message}` : message);
  }
  private recordSessionStarted(): void {
    if (this.activeMetricsSessionStartedAt !== undefined) return;
    this.activeMetricsSessionStartedAt = Date.now();
    if (this.activeMetricsSessionID) this.appendSessionLog(`time-to-session-start: ${this.milliseconds(this.activeMetricsRequestStartedAt, this.activeMetricsSessionStartedAt)}`);
  }
  private recordFirstOutputIfNeeded(): void {
    if (this.activeMetricsFirstOutputAt !== undefined) return;
    this.activeMetricsFirstOutputAt = Date.now();
    if (this.activeMetricsSessionID) this.appendSessionLog(`time-to-first-output: ${this.milliseconds(this.activeMetricsSessionStartedAt, this.activeMetricsFirstOutputAt)}`);
  }
  private recordSessionFinished(): void {
    if (this.activeMetricsSessionID) this.appendSessionLog(`session-duration: ${this.milliseconds(this.activeMetricsSessionStartedAt, Date.now())}`);
  }
  private resetSessionMetricsState(): void {
    this.activeMetricsSessionID = undefined;
    this.activeMetricsRequestStartedAt = undefined;
    this.activeMetricsSessionStartedAt = undefined;
    this.activeMetricsFirstOutputAt = undefined;
  }
  private resetTranslationRuntimeStateForClear(): void {
    this.activeTranslationTask?.cancel();
    this.orchestrator.cancelTranslation();
    this.activeTranslationTask = undefined;
    this.activeTranslationToken = undefined;
    this.isTranslating = false;
    this.pendingTranslationRequestStartedAt = undefined;
    this.partialTranslationsBySegment.clear();
    this.partialJoinersAfter = [];
    this.menuGeneration += 1;
    this.menuCancellation?.cancel();
    this.preparationCancellation?.cancel();
    this.tfMenuAvailabilityTask = undefined;
    if (this.tfMenuInputRefreshTask !== undefined) clearTimeout(this.tfMenuInputRefreshTask);
    this.tfMenuInputRefreshTask = undefined;
    this.tfMenuPreparationConfiguration = undefined;
    this.tfMenuPreparationTargetLanguageCode = undefined;
    this.tfMenuPreparationGeneration = util.generateRandomUUID();
    this.unsafeRecoveryController?.clearPendingRecoveryState();
    this.resetSessionMetricsState();
    this.appendDeveloperLog('clear: runtime cache/session state reset; native work may still be finishing');
  }
  private milliseconds(start: number | undefined, end: number): string { return start === undefined ? '(n/a)' : `${(end - start).toFixed(2)} ms`; }
  private detailedErrorLog(error: Error): string {
    const code = (error as BusinessError).code;
    return `Error: ${error.message} | Type: ${error.name}` + (typeof code === 'number' ? ` | Code: ${code}` : '');
  }

  // Standard translation runs on the bundled NLLB-200 model (on-device, MindSpore Lite), the port's Apple Translation
  // framework: one session follows the translation request's pair, the other the target menu's preparation.
  private installNllbSessions(context: common.Context): void {
    const controller: TranslationFrameworkUnsafeRecoveryController | undefined = this.unsafeRecoveryController;
    if (!controller) return;
    const model = new NllbModel();
    model.initialize(context);
    controller.setSession(new NllbSession(model, () => controller.configuration));
    this.setRecoverySession(new NllbSession(model, () => this.tfMenuPreparationConfiguration));
  }
  setRecoverySession(session?: RecoveryTranslationSession): void {
    this.recoverySession = session;
    this.refreshTFMenuAvailabilityIfNeeded();
    this.notifyStateChanged();
  }
  private refreshTFMenuAvailabilityIfNeeded(): void {
    this.menuGeneration += 1;
    const generation = this.menuGeneration;
    this.menuCancellation?.cancel();
    this.tfMenuAvailabilityTask = undefined;
    this.tfMenuAvailabilityByTarget = new Map();
    if (this.usesAppleIntelligenceTranslation || this.targetLanguageOptions.length === 0) {
      this.tfMenuUnsupportedHintMessage = undefined;
      return;
    }
    // No verified standard translation API: unknown keeps selection active without inventing installed packs.
    for (const option of this.targetLanguageOptions) this.tfMenuAvailabilityByTarget.set(option.code, TFMenuAvailabilityStatus.UNKNOWN);
    this.tfMenuUnsupportedHintMessage = undefined;
    const cancellation = new RecoveryCancellation();
    this.menuCancellation = cancellation;
    const options = this.targetLanguageOptions.slice();
    const source = TranslationViewModel.normalizedLanguageCode(this.detectedLanguageCode);
    const text = this.inputText.trim();
    const session = this.recoverySession;
    this.tfMenuAvailabilityTask = this.loadMenuAvailability(options, source, text, session, cancellation, generation);
  }
  private async loadMenuAvailability(options: TargetLanguageOption[], source: string, text: string,
    session: RecoveryTranslationSession | undefined, cancellation: RecoveryCancellation, generation: number): Promise<void> {
    const updated: Map<string, TFMenuAvailabilityStatus> = new Map();
    for (const option of options) {
      if (cancellation.cancelled) return;
      const status = await TranslationViewModel.resolveTFMenuAvailabilityStatus(source, text, option.code, session, cancellation);
      updated.set(option.code, status);
    }
    if (cancellation.cancelled || generation !== this.menuGeneration) return;
    this.tfMenuAvailabilityByTarget = updated;
    this.tfMenuUnsupportedHintMessage = this.unsupportedPairHintTextIfNeeded();
    this.notifyStateChanged();
  }
  private scheduleTFMenuAvailabilityRefresh(): void {
    if (this.tfMenuInputRefreshTask !== undefined) clearTimeout(this.tfMenuInputRefreshTask);
    this.tfMenuInputRefreshTask = setTimeout(() => {
      this.tfMenuInputRefreshTask = undefined;
      this.refreshTFMenuAvailabilityIfNeeded();
      this.notifyStateChanged();
    }, 250);
  }
  private static async resolveTFMenuAvailabilityStatus(detectedSourceCode: string, sourceText: string,
    targetCode: string, session?: RecoveryTranslationSession,
    cancellation: RecoveryCancellation = new RecoveryCancellation()): Promise<TFMenuAvailabilityStatus> {
    const target = TranslationViewModel.localeLanguage(targetCode);
    if (!target) return TFMenuAvailabilityStatus.UNSUPPORTED;
    if (!session) return TFMenuAvailabilityStatus.UNKNOWN;
    try {
      let status: RecoveryAvailabilityStatus;
      if (detectedSourceCode && detectedSourceCode !== 'und') {
        status = await session.availability.status(TranslationViewModel.localeLanguage(detectedSourceCode), target, cancellation);
      } else {
        if (!sourceText) return TFMenuAvailabilityStatus.UNKNOWN;
        status = await session.availability.statusForText(sourceText, target, cancellation);
      }
      return TranslationViewModel.tfMenuAvailabilityStatus(status);
    } catch (error) { return TFMenuAvailabilityStatus.UNKNOWN; }
  }
  private static tfMenuAvailabilityStatus(status: RecoveryAvailabilityStatus): TFMenuAvailabilityStatus {
    switch (status) {
      case RecoveryAvailabilityStatus.INSTALLED: return TFMenuAvailabilityStatus.INSTALLED;
      case RecoveryAvailabilityStatus.SUPPORTED: return TFMenuAvailabilityStatus.SUPPORTED;
      case RecoveryAvailabilityStatus.UNSUPPORTED: return TFMenuAvailabilityStatus.UNSUPPORTED;
      default: return TFMenuAvailabilityStatus.UNKNOWN;
    }
  }
  private requestTFLanguagePackDownload(code: string): void {
    const target = TranslationViewModel.localeLanguage(code);
    if (!target) return;
    this.preparationCancellation?.cancel();
    const cancellation = new RecoveryCancellation();
    this.preparationCancellation = cancellation;
    this.tfMenuPreparationTargetLanguageCode = code;
    const generation = util.generateRandomUUID();
    this.tfMenuPreparationGeneration = generation;
    this.tfMenuPreparationConfiguration = { source: TranslationViewModel.localeLanguage(this.detectedLanguageCode), target: target };
    this.appendDeveloperLog(`tf-menu: request language-pack download target=${code}`);
    if (!this.recoverySession) {
      this.completeTFMenuPreparation(generation, code, 'Language-pack download is not available on this platform.');
      return;
    }
    this.recoverySession.prepareTranslation(cancellation).then(() => {
      if (!cancellation.cancelled) this.completeTFMenuPreparation(generation, code);
    }).catch((error: Error) => {
      if (!cancellation.cancelled) this.completeTFMenuPreparation(generation, code, error.message);
    });
  }
  tfMenuPreparationTargetCode(generation: string): string | undefined {
    return generation === this.tfMenuPreparationGeneration && this.tfMenuPreparationConfiguration
      ? this.tfMenuPreparationTargetLanguageCode : undefined;
  }
  completeTFMenuPreparation(generation: string, targetCode: string, errorDescription?: string): void {
    if (generation !== this.tfMenuPreparationGeneration) return;
    this.appendDeveloperLog(errorDescription
      ? `tf-menu: language-pack prepare failed target=${targetCode} | ${errorDescription}`
      : `tf-menu: language-pack prepared target=${targetCode}`);
    if (errorDescription) {
      this.userAlert = this.alertForLocalizedDescription(errorDescription);
      this.errorMessage = this.userAlert?.inlineMessage ?? errorDescription;
    }
    this.tfMenuPreparationConfiguration = undefined;
    this.tfMenuPreparationTargetLanguageCode = undefined;
    this.refreshTFMenuAvailabilityIfNeeded();
    this.notifyStateChanged();
  }
  // iOS shows the system Translation download prompt while a menu-selected pack downloads; HarmonyOS has none,
  // so the status strip shows the download instead.
  get languagePackDownloadText(): string | undefined {
    const code = this.tfMenuPreparationConfiguration ? this.tfMenuPreparationTargetLanguageCode : undefined;
    return code === undefined ? undefined : this.localized('tf.menu.downloading_format', 'Downloading the %1$s language pack…')
      .replace('%1$s', this.targetLanguageDisplayNameForMenu(code));
  }
  get shouldShowIOSTFUnsupportedHint(): boolean {
    return !this.usesAppleIntelligenceTranslation && Array.from(this.tfMenuAvailabilityByTarget.values()).includes(TFMenuAvailabilityStatus.UNSUPPORTED)
      && (this.tfMenuUnsupportedHintMessage ?? '').length > 0;
  }
  get iosTFUnsupportedHintMessage(): string { return this.tfMenuUnsupportedHintMessage ?? this.unsupportedPairHintText(this.targetLanguage); }
  private unsupportedPairHintTextIfNeeded(): string | undefined {
    for (const option of this.targetLanguageOptions) {
      if (this.tfMenuAvailabilityByTarget.get(option.code) === TFMenuAvailabilityStatus.UNSUPPORTED) return this.unsupportedPairHintText(option.code);
    }
    return undefined;
  }
  private unsupportedPairHintText(code: string): string {
    return this.localized('tf.menu.unsupported_pair_format', 'Cannot translate from %1$s to %2$s.')
      .replace('%1$s', this.sourceLanguageDisplayNameForMenu()).replace('%2$s', this.targetLanguageDisplayNameForMenu(code));
  }
  private get localizedDownloadHintText(): string { return this.localized('tf.menu.download_hint', 'Downloads the language pack.'); }
  private sourceLanguageDisplayNameForMenu(): string {
    const code = TranslationViewModel.normalizedLanguageCode(this.detectedLanguageCode);
    return code && code !== 'und' ? this.languageDisplayName(code)
      : this.localized('tf.menu.source_language_fallback', 'source language');
  }
  private targetLanguageDisplayNameForMenu(code: string): string {
    const normalized = TranslationViewModel.normalizedLanguageCode(code);
    return normalized && normalized !== 'und' ? this.languageDisplayName(normalized)
      : this.localized('tf.menu.target_language_fallback', 'target language');
  }
  private languageDisplayName(code: string): string {
    return this.targetLanguageOptions.find((option) => option.code === code)?.displayName ?? code;
  }
  private localized(key: string, defaultValue: string): string {
    if (!this.context) return defaultValue;
    try { return this.context.resourceManager.getStringByNameSync(key.replace(/\./g, '_')); }
    catch (error) { return defaultValue; }
  }
  private makeStatusNotices(output: TranslationOutput, request: TranslationRequest): StatusNotice[] {
    const kinds: StatusNoticeKind[] = [];
    const detected = (output.analysis.input.detectedLanguageCode ?? '').toLowerCase();
    const same = detected.length > 0 && detected !== 'und' &&
      TranslationViewModel.normalizedLanguageCode(detected) === TranslationViewModel.normalizedLanguageCode(request.targetLanguage);
    const allSource = output.segmentOutputs.length > 0 && output.segmentOutputs.every((segment) =>
      segment.isUnsafeFallback && !segment.isUnsafeRecoveredByTranslationFramework) && output.translatedText === request.text;
    if (output.analysis.engineName === 'same-language-fallback' || (same && allSource)) kinds.push(StatusNoticeKind.SAME_LANGUAGE_UNTRANSLATABLE);
    const recovered = output.segmentOutputs.some((segment) => segment.isUnsafeRecoveredByTranslationFramework);
    if (recovered) kinds.push(StatusNoticeKind.AI_FALLBACK_TO_MACHINE_TRANSLATION);
    if (request.usesAITranslation && !recovered && output.analysis.engineName !== 'same-language-fallback' &&
      output.segmentOutputs.some((segment) => segment.isUnsafeFallback && !segment.isUnsafeRecoveredByTranslationFramework)) {
      kinds.push(StatusNoticeKind.AI_FALLBACK_TO_MACHINE_TRANSLATION_UNAVAILABLE);
    }
    if (detected === 'und' && output.translatedText === request.text && output.segmentOutputs.every((segment) => segment.isUnsafeFallback)) {
      kinds.push(StatusNoticeKind.UNKNOWN_SOURCE_LANGUAGE);
    }
    return kinds.map((kind) => this.statusNotice(kind));
  }
  private statusNotice(kind: StatusNoticeKind): StatusNotice {
    switch (kind) {
      case StatusNoticeKind.SAME_LANGUAGE_UNTRANSLATABLE:
        return new StatusNotice('text', this.localized('status.notice.same_language_untranslatable',
          'Could not translate because source and target are the same language.'), StatusNoticeStyle.ORANGE);
      case StatusNoticeKind.AI_FALLBACK_TO_MACHINE_TRANSLATION:
        return new StatusNotice('text', this.localized('status.notice.ai_fallback_to_tf',
          'AI translation could not complete, so machine translation was used.'), StatusNoticeStyle.BLUE);
      case StatusNoticeKind.AI_FALLBACK_TO_MACHINE_TRANSLATION_UNAVAILABLE:
        return new StatusNotice('text', this.localized('status.notice.ai_fallback_to_tf',
          'AI translation could not complete, so machine translation was used.'), StatusNoticeStyle.ORANGE);
      case StatusNoticeKind.UNKNOWN_SOURCE_LANGUAGE:
        return new StatusNotice('text', this.localized('status.notice.unknown_source_language',
          'Could not translate because the source language could not be detected.'), StatusNoticeStyle.ORANGE);
    }
  }
  private alertForError(error: Error): UserAlert | undefined {
    const message = error.message;
    const combined = message.toLowerCase();
    if (error instanceof TranslationPlatformUnavailableError) {
      return new UserAlert(this.isJapaneseLocale ? '翻訳サービスを利用できません' : 'Translation Service Unavailable',
        message, message, false);
    }
    if ((error as BusinessError).code === 4097 || combined.includes('connection to service') ||
      combined.includes('translationd') || combined.includes('com.apple.translation.text') || combined.includes('availablelocalepairsfortask')) {
      return new UserAlert(this.isJapaneseLocale ? '翻訳サービスに接続できません' : 'Translation Service Unavailable',
        message, this.isJapaneseLocale ? '翻訳サービスに接続できません。再試行してください。' : 'Translation service is unavailable. Please retry.', true);
    }
    return this.alertForLocalizedDescription(message);
  }
  private alertForLocalizedDescription(message: string): UserAlert | undefined {
    if (message.includes('not available on this platform')) {
      return new UserAlert(this.isJapaneseLocale ? '翻訳サービスを利用できません' : 'Translation Service Unavailable',
        message, message, false);
    }
    if (message.includes('current build toolchain')) {
      return new UserAlert(this.isJapaneseLocale ? 'Foundation Models を利用できません' : 'Foundation Models Unavailable',
        message, this.isJapaneseLocale ? 'Foundation Models を利用できません。' : 'Foundation Models is unavailable in the current build toolchain.', false);
    }
    if (message.includes('requires macOS 26.0+ / iOS 26.0+')) {
      return new UserAlert(this.isJapaneseLocale ? '対応していないOSです' : 'Unsupported OS Version', message,
        this.isJapaneseLocale ? '対応OSが必要です。' : 'A supported OS version is required.', false);
    }
    if (message.includes('Foundation Models is unavailable') || message.includes('Enable Apple Intelligence') ||
      message.includes('finish downloading model assets') || /AI translation.*not available/.test(message)) {
      return new UserAlert(this.isJapaneseLocale ? 'AIモデルを確認してください' : 'Check AI Model Availability', message,
        this.isJapaneseLocale ? 'AIモデルの利用可否を確認してください。' : 'Check AI model availability and downloads.', true);
    }
    if (message.includes('language-pack download') || message.includes('Language-pack download') || message.includes('Translation Framework could not complete translation')) {
      const pair = this.extractLanguagePair(message);
      if (pair && TranslationViewModel.normalizedLanguageCode(pair.source) === TranslationViewModel.normalizedLanguageCode(pair.target)) {
        const label = `${pair.source} -> ${pair.target}`;
        return new UserAlert(this.localized('alert.same_language_pair.title', 'Same Language Pair'),
          this.localized('alert.same_language_pair.message_format', 'The source and target language are the same (%1$s). Select a different target language and try again.').replace('%1$s', label),
          this.localized('alert.same_language_pair.inline_format', 'Cannot translate with the same language pair (%1$s).').replace('%1$s', label), false);
      }
      // Alert texts as iOS (TranslationViewModel.swift alertForLocalizedDescription): a readable message, not the raw error.
      const ja = this.isJapaneseLocale;
      const settingsHint = ja ? 'Settingsでダウンロード状況を確認し、完了後に再起動してから再実行してください。'
        : 'Check download status in Settings, then relaunch and try again.';
      if (pair) {
        const source = this.languageAvailabilityLabel(pair.source, LanguageRole.SOURCE);
        const target = this.languageAvailabilityLabel(pair.target, LanguageRole.TARGET);
        const kind = this.extractRecoveryFailureKind(message);
        const dataTitle = ja ? '翻訳言語データを確認してください' : 'Check Translation Language Data';
        switch (kind) {
          case 'missing_source_language':
            return new UserAlert(dataTitle, ja ? `${source} がありません。${settingsHint}` : `${source} is unavailable. ${settingsHint}`,
              ja ? `${source} がありません。` : `${source} is unavailable.`, false);
          case 'missing_target_language':
            return new UserAlert(dataTitle, ja ? `${target} がありません。${settingsHint}` : `${target} is unavailable. ${settingsHint}`,
              ja ? `${target} がありません。` : `${target} is unavailable.`, false);
          case 'missing_source_and_target_language':
            return new UserAlert(dataTitle,
              ja ? `${source} と ${target} がありません。${settingsHint}` : `${source} and ${target} are unavailable. ${settingsHint}`,
              ja ? `${source} と ${target} がありません。` : `${source} and ${target} are unavailable.`, false);
          case 'unsupported_language_pairing':
            return new UserAlert(ja ? '翻訳言語ペアを確認してください' : 'Check Translation Language Pair',
              ja ? `言語ペア（${source} -> ${target}）が利用できません。Settingsで言語データの状況を確認し、必要に応じてダウンロードしてから再実行してください。`
                : `The language pair (${source} -> ${target}) is unavailable. Check language data in Settings and download if needed, then try again.`,
              ja ? `言語ペア（${source} -> ${target}）が利用できません。` : `The language pair (${source} -> ${target}) is unavailable.`, false);
          default:
            break;
        }
      }
      return new UserAlert(ja ? '翻訳言語データを確認してください' : 'Check Translation Language Data',
        ja ? `対象の言語ペアが利用できません。${settingsHint}` : `The required language pair is unavailable. ${settingsHint}`,
        ja ? '言語データのダウンロード状況をSettingsで確認してください。' : 'Check language data download status in Settings.', false);
    }
    return undefined;
  }
  private get isJapaneseLocale(): boolean { return this.preferredLanguages[0]?.startsWith('ja') ?? false; }
  private extractLanguagePair(message: string): LanguagePair | undefined {
    const start = message.lastIndexOf('(');
    const end = message.indexOf(')', start);
    if (start < 0 || end <= start) return undefined;
    const parts = message.slice(start + 1, end).split('->');
    if (parts.length !== 2 || parts[0].trim().length === 0 || parts[1].trim().length === 0) return undefined;
    return { source: parts[0].trim(), target: parts[1].trim() };
  }
  private extractRecoveryFailureKind(message: string): string | undefined {
    const start = message.indexOf('reason=');
    if (start < 0) return undefined;
    const token = message.slice(start + 7).split(' ')[0].replace(/^\.+|\.+$/g, '');
    return token.length > 0 ? token : undefined;
  }
  private languageAvailabilityLabel(code: string, role: LanguageRole): string {
    const normalized = TranslationViewModel.normalizedLanguageCode(code);
    if (normalized && normalized !== 'und') return code;
    return role === LanguageRole.SOURCE ? this.localized('tf.menu.source_language_fallback', 'source language')
      : this.localized('tf.menu.target_language_fallback', 'target language');
  }
  private normalizedLineEndings(text: string): string { return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }
  private static normalizedLanguageCode(code: string): string { return code.trim().toLowerCase().split(/[-_]/)[0]; }
  private static normalizedLanguageIdentifier(code: string): string {
    const normalized = code.trim().toLowerCase().replace(/_/g, '-');
    return normalized === 'en-uk' ? 'en-gb' : normalized;
  }
  private static localeLanguage(code: string): string | undefined { return code.trim().length > 0 ? code.trim() : undefined; }
  private static preferredDefaultTargetLanguageCode(options: TargetLanguageOption[], preferred: string[]): string | undefined {
    if (options.length === 0) return undefined;
    for (const language of preferred) {
      const match = TranslationViewModel.matchingTargetLanguageCode(language, options);
      if (match) return match;
    }
    return TranslationViewModel.matchingTargetLanguageCode('en-US', options)
      ?? TranslationViewModel.matchingTargetLanguageCode('en', options) ?? options[0].code;
  }
  private static matchingTargetLanguageCode(raw: string, options: TargetLanguageOption[]): string | undefined {
    const normalized = TranslationViewModel.normalizedLanguageIdentifier(raw);
    if (!normalized) return undefined;
    for (const candidate of TranslationViewModel.preferredLanguageCandidates(normalized)) {
      const match = options.find((option) => TranslationViewModel.normalizedLanguageIdentifier(option.code) === candidate);
      if (match) return match.code;
    }
    const base = TranslationViewModel.normalizedLanguageCode(normalized);
    return options.find((option) => TranslationViewModel.normalizedLanguageCode(option.code) === base)?.code;
  }
  private static preferredLanguageCandidates(normalized: string): string[] {
    const parts = normalized.split('-');
    const language = parts[0];
    if (!language) return [];
    let script: string | undefined;
    let region: string | undefined;
    for (const part of parts.slice(1)) {
      if (part.length === 4) script = part.toLowerCase();
      else if (part.length === 2 || part.length === 3) region = part.toUpperCase();
    }
    script = script ?? TranslationViewModel.inferredChineseScript(language, region);
    const candidates: string[] = [normalized];
    if (script) {
      if (region) candidates.push(`${language}-${script}-${region.toLowerCase()}`);
      candidates.push(`${language}-${script}`);
    }
    if (region) candidates.push(`${language}-${region.toLowerCase()}`);
    candidates.push(language);
    return Array.from(new Set(candidates));
  }
  private static inferredChineseScript(language: string, region?: string): string | undefined {
    if (language !== 'zh' || !region) return undefined;
    if (['TW', 'HK', 'MO'].includes(region.toUpperCase())) return 'hant';
    if (['CN', 'SG', 'MY'].includes(region.toUpperCase())) return 'hans';
    return undefined;
  }
  get clutchSegmentBindings(): ClutchSegmentBinding[] {
    const segments = this.sourceSegments.slice().sort((a, b) => a.index - b.index);
    let cursor = 0;
    return segments.map((segment, offset) => {
      const range: NSRange = { location: cursor, length: segment.text.length };
      cursor += range.length + (this.segmentJoinersAfter[offset]?.length ?? 0);
      const binding: ClutchSegmentBinding = { segmentIndex: segment.index, sourceRange: range };
      return binding;
    });
  }
  handleOutputSegmentTap(index: number): void {
    if (!this.clutchModeEnabled) return;
    this.clutchSelectedSegmentIndex = index;
    const binding = this.clutchSegmentBindings.find((candidate) => candidate.segmentIndex === index);
    if (binding) this.sourceHighlightRange = binding.sourceRange;
    this.notifyStateChanged();
  }
  handleSourceCursorLocationChange(location: number): void {
    const binding = this.clutchModeEnabled && this.inputText === this.sourceTextSnapshotForSegments
      ? this.clutchSegmentBindings.find((candidate) => location >= candidate.sourceRange.location &&
        location <= candidate.sourceRange.location + candidate.sourceRange.length) : undefined;
    this.sourceHighlightRange = binding?.sourceRange;
    this.clutchSelectedSegmentIndex = binding?.segmentIndex;
    this.notifyStateChanged();
  }
  setMacImportLoadingHUDVisible(visible: boolean): void { this.appendDeveloperLog(`macOS import HUD inactive on phone: loading=${visible}`); }
  showMacImportHUDMessage(message: string): void { this.appendDeveloperLog(`macOS import HUD inactive on phone: ${message}`); }
  clearMacImportHUDMessage(): void { this.appendDeveloperLog('macOS import HUD inactive on phone: clear'); }
}

export class URLLaunchParser {
  static extractText(url: string): string | undefined {
    const match = /^([a-z][a-z0-9+.-]*):(?:\/\/[^/?#]*)?([^?#]*)(?:\?([^#]*))?/i.exec(url);
    if (!match || match[1].toLowerCase() !== 'prebabellens') return undefined;
    const query = match[3] ?? '';
    for (const item of query.split('&')) {
      const separator = item.indexOf('=');
      const name = separator >= 0 ? item.slice(0, separator) : item;
      if (URLLaunchParser.decode(name) === 'text') {
        if (separator >= 0) return URLLaunchParser.decode(item.slice(separator + 1));
        break;
      }
    }
    const path = match[2].replace(/^\/+|\/+$/g, '');
    return path.length > 0 ? URLLaunchParser.decode(path) : undefined;
  }
  private static decode(value: string): string {
    try { return decodeURIComponent(value); }
    catch (error) { return value; }
  }
}
