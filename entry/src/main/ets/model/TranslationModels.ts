import { util } from '@kit.ArkTS';

export enum TranslationExperimentMode {
  RAW_INPUT = 'rawInput',
  SEGMENTED = 'segmented',
  SEGMENTED_GLOSSARY = 'segmentedGlossary',
  SEGMENTED_GLOSSARY_PROTECTED = 'segmentedGlossaryProtected'
}

export const TRANSLATION_EXPERIMENT_MODES: TranslationExperimentMode[] = [
  TranslationExperimentMode.RAW_INPUT, TranslationExperimentMode.SEGMENTED,
  TranslationExperimentMode.SEGMENTED_GLOSSARY, TranslationExperimentMode.SEGMENTED_GLOSSARY_PROTECTED
];

export function experimentModeDisplayName(mode: TranslationExperimentMode): string {
  switch (mode) {
    case TranslationExperimentMode.RAW_INPUT: return 'Raw Input';
    case TranslationExperimentMode.SEGMENTED: return 'Segmented';
    case TranslationExperimentMode.SEGMENTED_GLOSSARY: return 'Segmented + Glossary';
    case TranslationExperimentMode.SEGMENTED_GLOSSARY_PROTECTED: return 'Segmented + Glossary + Protected';
  }
}

export function usesSegmentation(mode: TranslationExperimentMode): boolean {
  return mode !== TranslationExperimentMode.RAW_INPUT;
}

export function usesGlossary(mode: TranslationExperimentMode): boolean {
  return mode === TranslationExperimentMode.SEGMENTED_GLOSSARY ||
    mode === TranslationExperimentMode.SEGMENTED_GLOSSARY_PROTECTED;
}

export function usesProtectedTokens(mode: TranslationExperimentMode): boolean {
  return mode === TranslationExperimentMode.SEGMENTED_GLOSSARY_PROTECTED;
}

export interface GlossaryEntry {
  source: string;
  target: string;
}

export class TranslationRequest {
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  glossary: GlossaryEntry[];
  preferredLanguages: string[];
  experimentMode: TranslationExperimentMode;
  usesAITranslation: boolean;

  constructor(sourceLanguage: string, targetLanguage: string, text: string, glossary: GlossaryEntry[],
    preferredLanguages: string[] = [],
    experimentMode: TranslationExperimentMode = TranslationExperimentMode.SEGMENTED_GLOSSARY_PROTECTED,
    usesAITranslation: boolean = false) {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.text = text;
    this.glossary = glossary;
    this.preferredLanguages = preferredLanguages;
    this.experimentMode = experimentMode;
    this.usesAITranslation = usesAITranslation;
  }
}

export class TranslationInput {
  sourceLanguage: string;
  targetLanguage: string;
  originalText: string;
  preferredLanguages: string[];
  detectedLanguageCode?: string;
  isDetectedLanguageSupportedByAppleIntelligence: boolean;
  segments: TextSegment[];
  segmentJoinersAfter: string[];
  protectedTokens: ProtectedToken[];
  glossaryMatches: GlossaryMatch[];
  ambiguityHints: AmbiguityHint[];
  formatting: FormattingProfile;

  constructor(sourceLanguage: string, targetLanguage: string, originalText: string,
    segments: TextSegment[], protectedTokens: ProtectedToken[], glossaryMatches: GlossaryMatch[],
    ambiguityHints: AmbiguityHint[], formatting: FormattingProfile, preferredLanguages: string[] = [],
    detectedLanguageCode?: string, isDetectedLanguageSupportedByAppleIntelligence: boolean = true,
    segmentJoinersAfter: string[] = []) {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.originalText = originalText;
    this.preferredLanguages = preferredLanguages;
    this.detectedLanguageCode = detectedLanguageCode;
    this.isDetectedLanguageSupportedByAppleIntelligence = isDetectedLanguageSupportedByAppleIntelligence;
    this.segments = segments;
    this.segmentJoinersAfter = segmentJoinersAfter;
    this.protectedTokens = protectedTokens;
    this.glossaryMatches = glossaryMatches;
    this.ambiguityHints = ambiguityHints;
    this.formatting = formatting;
  }
}

export interface TranslationOutput {
  translatedText: string;
  containsUnsafeFallback: boolean;
  segmentOutputs: SegmentOutput[];
  analysis: TranslationAnalysis;
}

export enum SegmentKind {
  HEADING = 'heading',
  GENERAL = 'general',
  DIALOGUE = 'dialogue',
  UI_LABELS = 'ui-labels',
  LISTS = 'lists',
  CODES_OR_PATH = 'codes_or_path'
}

export enum SegmentRole {
  LEADING = 'leading',
  REGULAR = 'regular'
}

export const SEGMENT_KINDS: SegmentKind[] = [
  SegmentKind.HEADING, SegmentKind.GENERAL, SegmentKind.DIALOGUE,
  SegmentKind.UI_LABELS, SegmentKind.LISTS, SegmentKind.CODES_OR_PATH
];

export const SEGMENT_ROLES: SegmentRole[] = [SegmentRole.LEADING, SegmentRole.REGULAR];

export class TextSegment {
  readonly id: string;
  index: number;
  text: string;
  kind: SegmentKind;
  role: SegmentRole;

  constructor(index: number, text: string, kind: SegmentKind = SegmentKind.GENERAL,
    role?: SegmentRole, id: string = util.generateRandomUUID()) {
    this.id = id;
    this.index = index;
    this.text = text;
    this.kind = kind;
    this.role = role ?? (index === 0 ? SegmentRole.LEADING : SegmentRole.REGULAR);
  }
}

export class SegmentOutput {
  readonly id: string;
  segmentIndex: number;
  sourceText: string;
  translatedText: string;
  isUnsafeFallback: boolean;
  isUnsafeRecoveredByTranslationFramework: boolean;

  constructor(segmentIndex: number, sourceText: string, translatedText: string,
    isUnsafeFallback: boolean = false, isUnsafeRecoveredByTranslationFramework: boolean = false,
    id: string = util.generateRandomUUID()) {
    this.id = id;
    this.segmentIndex = segmentIndex;
    this.sourceText = sourceText;
    this.translatedText = translatedText;
    this.isUnsafeFallback = isUnsafeFallback;
    this.isUnsafeRecoveredByTranslationFramework = isUnsafeRecoveredByTranslationFramework;
  }
}

// Offsets are UTF-16 code units; end is exclusive, matching ArkTS string slicing and editor selection.
export interface TextRange {
  start: number;
  end: number;
}

export interface NSRange {
  location: number;
  length: number;
}

export enum ProtectedTokenKind {
  URL = 'url',
  FILE_PATH = 'filePath',
  CODE_SNIPPET = 'codeSnippet',
  PROPER_NOUN_CANDIDATE = 'properNounCandidate',
  NUMBER = 'number'
}

export class ProtectedToken {
  readonly id: string;
  kind: ProtectedTokenKind;
  value: string;
  range: TextRange;

  constructor(kind: ProtectedTokenKind, value: string, range: TextRange,
    id: string = util.generateRandomUUID()) {
    this.id = id;
    this.kind = kind;
    this.value = value;
    this.range = range;
  }
}

export class GlossaryMatch {
  readonly id: string;
  source: string;
  target: string;
  range: TextRange;

  constructor(source: string, target: string, range: TextRange, id: string = util.generateRandomUUID()) {
    this.id = id;
    this.source = source;
    this.target = target;
    this.range = range;
  }
}

export class AmbiguityHint {
  readonly id: string;
  category: string;
  message: string;

  constructor(category: string, message: string, id: string = util.generateRandomUUID()) {
    this.id = id;
    this.category = category;
    this.message = message;
  }
}

export interface FormattingProfile {
  leadingWhitespace: string;
  trailingWhitespace: string;
  newlineCount: number;
}

export class PreprocessTrace {
  readonly id: string;
  step: string;
  summary: string;

  constructor(step: string, summary: string, id: string = util.generateRandomUUID()) {
    this.id = id;
    this.step = step;
    this.summary = summary;
  }
}

export interface TranslationAnalysis {
  request: TranslationRequest;
  traces: PreprocessTrace[];
  input: TranslationInput;
  engineName: string;
}

export interface HeuristicLanguageDetectionResult {
  detectedLanguageCode: string;
  isSupportedByAppleIntelligence: boolean;
  method: string;
}

export interface SentenceUnit {
  text: string;
  joinerAfter: string;
}

export interface SegmentationResult {
  segments: TextSegment[];
  joinersAfter: string[];
}

export interface VoidContinuation {
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface Waiter {
  id: string;
  continuation: VoidContinuation;
}

export interface StructuredTranslationPayload {
  targetLanguage: string;
  translation: string;
}

export interface StructuredTranslationResult {
  translation: string;
  outputBreakTagCount: number;
}

export interface ClutchSegmentBinding {
  segmentIndex: number;
  sourceRange: NSRange;
}

export class LayoutTokens {
  sectionTitleFontSize: number;
  statusTextFontSize: number;
  editorInnerPadding: number;
  cardOuterPadding: number;
  cardCornerRadius: number;
  editorCornerRadius: number;
  editorMinHeight: number;
  outputStatusReservedHeight: number;

  static readonly IOS_LIKE: LayoutTokens = new LayoutTokens(18, 14, 8, 0, 0, 0, 170, 22);
  static readonly DESKTOP: LayoutTokens = new LayoutTokens(18, 14, 8, 22, 26, 18, 300, 22);

  constructor(sectionTitleFontSize: number, statusTextFontSize: number, editorInnerPadding: number,
    cardOuterPadding: number, cardCornerRadius: number, editorCornerRadius: number,
    editorMinHeight: number, outputStatusReservedHeight: number) {
    this.sectionTitleFontSize = sectionTitleFontSize;
    this.statusTextFontSize = statusTextFontSize;
    this.editorInnerPadding = editorInnerPadding;
    this.cardOuterPadding = cardOuterPadding;
    this.cardCornerRadius = cardCornerRadius;
    this.editorCornerRadius = editorCornerRadius;
    this.editorMinHeight = editorMinHeight;
    this.outputStatusReservedHeight = outputStatusReservedHeight;
  }
}

export enum StatusNoticeKind {
  SAME_LANGUAGE_UNTRANSLATABLE = 'sameLanguageUntranslatable',
  AI_FALLBACK_TO_MACHINE_TRANSLATION = 'aiFallbackToMachineTranslation',
  AI_FALLBACK_TO_MACHINE_TRANSLATION_UNAVAILABLE = 'aiFallbackToMachineTranslationUnavailable',
  UNKNOWN_SOURCE_LANGUAGE = 'unknownSourceLanguage'
}

export enum StatusNoticeStyle {
  ORANGE = 'orange',
  BLUE = 'blue'
}

export class StatusNotice {
  readonly id: string;
  readonly markerText: string;
  readonly text: string;
  readonly style: StatusNoticeStyle;

  constructor(markerText: string, text: string, style: StatusNoticeStyle,
    id: string = util.generateRandomUUID()) {
    this.id = id;
    this.markerText = markerText;
    this.text = text;
    this.style = style;
  }
}

export class UserAlert {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly inlineMessage: string;
  readonly offersSettingsShortcut: boolean;

  constructor(title: string, message: string, inlineMessage: string, offersSettingsShortcut: boolean,
    id: string = util.generateRandomUUID()) {
    this.id = id;
    this.title = title;
    this.message = message;
    this.inlineMessage = inlineMessage;
    this.offersSettingsShortcut = offersSettingsShortcut;
  }
}

export enum TranslationStatusKind {
  READY = 'ready',
  PROCESSING = 'processing',
  TRANSLATING = 'translating',
  STOPPED = 'stopped',
  COMPLETED = 'completed'
}

export interface TranslationStatus {
  kind: TranslationStatusKind;
  mode?: TranslationExperimentMode;
  current?: number;
  total?: number;
}

export enum TFMenuAvailabilityStatus {
  UNKNOWN = 'unknown',
  INSTALLED = 'installed',
  SUPPORTED = 'supported',
  UNSUPPORTED = 'unsupported'
}

export enum TargetLanguageLabelStyle {
  AI = 'ai',
  MACHINE = 'machine'
}

export class TargetLanguageOption {
  readonly code: string;
  readonly displayName: string;
  readonly nativeDisplayName: string;

  constructor(code: string, displayName: string, nativeDisplayName: string) {
    this.code = code;
    this.displayName = displayName;
    this.nativeDisplayName = nativeDisplayName;
  }

  get id(): string {
    return this.code;
  }

  menuLabel(showCode: boolean, style: TargetLanguageLabelStyle): string {
    let label: string;
    switch (this.code.toLowerCase()) {
      case 'en':
      case 'en-us': label = style === TargetLanguageLabelStyle.AI ? 'English' : 'English (US)'; break;
      case 'en-gb': label = 'English (UK)'; break;
      case 'zh':
      case 'zh-hans': label = style === TargetLanguageLabelStyle.AI ? '中文' : '中文 (简体)'; break;
      case 'zh-hant': label = '中文 (繁体)'; break;
      default: label = this.nativeDisplayName;
    }
    return showCode ? `${this.code} - ${label}` : label;
  }
}

export enum RecoveryChunkKind {
  TEXT = 'text',
  SEPARATOR = 'separator'
}

export interface RecoveryChunk {
  readonly kind: RecoveryChunkKind;
  readonly value: string;
}

export enum SourceLanguageResolutionReason {
  REQUESTED = 'requested',
  ESTIMATED_FROM_TEXT = 'estimated_from_text',
  FALLBACK_PREVIOUS_SUCCESS = 'fallback_previous_success',
  UNDETERMINED = 'undetermined'
}

export interface PendingRequest {
  readonly id: string;
  readonly sourceText: string;
  readonly sourceLanguage: string;
  readonly resolvedSourceLanguageCode?: string;
  readonly sourceLanguageResolutionReason: SourceLanguageResolutionReason;
  readonly targetLanguage: string;
  readonly onDiagnosticEvent?: (message: string) => void;
}
