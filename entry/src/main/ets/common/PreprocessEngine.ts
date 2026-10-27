import {
  AmbiguityHint, FormattingProfile, GlossaryEntry, GlossaryMatch,
  HeuristicLanguageDetectionResult, PreprocessTrace, ProtectedToken, ProtectedTokenKind,
  SegmentationResult, SentenceUnit, TextRange, TextSegment, TranslationInput,
  TranslationRequest, usesGlossary, usesProtectedTokens, usesSegmentation
} from '../model/TranslationModels';
import nllb from 'libnllb_napi.so';
import { PreprocessEngine, PreprocessResult } from './TranslationProtocols';

function trimWhitespace(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

interface SegmentationLimits {
  maxCharacters: number;
  maxWords: number;
}

interface LanguageClues {
  code: string;
  words: string;
}

export class DeterministicPreprocessEngine implements PreprocessEngine {
  readonly name: string = 'deterministic-v1';

  analyze(request: TranslationRequest): PreprocessResult {
    const startedAt: number = Date.now();
    const traces: PreprocessTrace[] = [new PreprocessTrace('experiment-mode', request.experimentMode)];
    const detection: HeuristicLanguageDetectionResult = HeuristicLanguageDetector.detectLanguage(request.text);
    traces.push(new PreprocessTrace('language-detection',
      `detected=${detection.detectedLanguageCode}, ai_supported=${detection.isSupportedByAppleIntelligence}, method=${detection.method}`));
    const segmentation: SegmentationResult = usesSegmentation(request.experimentMode)
      ? SentenceSegmenter.segment(request.text, request.usesAITranslation)
      : RawInputSegmenter.segment(request.text);
    traces.push(new PreprocessTrace('sentence-segmentation', `segments=${segmentation.segments.length}`));
    const protectedTokens: ProtectedToken[] = usesProtectedTokens(request.experimentMode)
      ? ProtectedTokenExtractor.extract(request.text) : [];
    traces.push(new PreprocessTrace('protected-token-extraction', `tokens=${protectedTokens.length}`));
    const glossaryMatches: GlossaryMatch[] = usesGlossary(request.experimentMode)
      ? GlossaryMatcher.match(request.glossary, request.text) : [];
    traces.push(new PreprocessTrace('glossary-application', `matches=${glossaryMatches.length}`));
    const ambiguityHints: AmbiguityHint[] = AmbiguityHintDetector.detect(request.text);
    traces.push(new PreprocessTrace('ambiguity-hinting', `hints=${ambiguityHints.length}`));
    const formatting: FormattingProfile = FormattingInspector.inspect(request.text);
    traces.push(new PreprocessTrace('formatting-preservation', `newlines=${formatting.newlineCount}`));
    traces.push(new PreprocessTrace('deterministic-processing-time', `${(Date.now() - startedAt).toFixed(2)} ms`));
    const input: TranslationInput = new TranslationInput(detection.detectedLanguageCode, request.targetLanguage,
      request.text, segmentation.segments, protectedTokens, glossaryMatches, ambiguityHints, formatting,
      request.preferredLanguages, detection.detectedLanguageCode, detection.isSupportedByAppleIntelligence,
      segmentation.joinersAfter);
    const result: PreprocessResult = { input: input, traces: traces };
    return result;
  }
}

export class HeuristicLanguageDetector {
  private static readonly FALLBACK_SUPPORTED_LANGUAGE_CODES: Set<string> = new Set<string>([
    'da', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nb', 'nl', 'pt', 'sv', 'tr', 'vi', 'zh'
  ]);
  private static readonly LATIN_CLUES: LanguageClues[] = [
    { code: 'da', words: 'og jeg ikke det er en et til med tak hej dansk' },
    { code: 'de', words: 'der die das und ist nicht ein eine ich mit danke hallo deutsch' },
    { code: 'en', words: 'the is are and this that you they it of to for with hello thanks english' },
    { code: 'es', words: 'el la los las es una un que por para con hola gracias español' },
    { code: 'fr', words: 'le la les est une un et des pour avec bonjour merci français' },
    { code: 'it', words: 'il lo gli è una un che per con ciao grazie italiano' },
    { code: 'nb', words: 'og jeg ikke det er en et til med takk hei norsk' },
    { code: 'nl', words: 'de het een is en niet ik voor met hallo bedankt nederlands' },
    { code: 'pt', words: 'o os as é uma um que para com olá obrigado obrigada português' },
    { code: 'sv', words: 'och jag inte det är en ett till med tack hej svenska' },
    { code: 'tr', words: 've bir bu için ile değil merhaba teşekkür türkçe' },
    { code: 'vi', words: 'và là của tôi bạn không một xin chào cảm ơn tiếng việt' }
  ];

  static detectLanguage(text: string): HeuristicLanguageDetectionResult {
    const trimmed: string = trimWhitespace(text);
    let code: string = 'und';
    let method: string = trimmed.length === 0 ? 'heuristic-empty-input' : 'owned-heuristic-undetermined';
    // shortcut: no verified dominant-language/hypothesis API; replace these clues when one is proven on-device.
    if (trimmed.length > 0) {
      const kana: number = (trimmed.match(/[\u3040-\u30ff\u31f0-\u31ff]/g) ?? []).length;
      const hangul: number = (trimmed.match(/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g) ?? []).length;
      const han: number = (trimmed.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
      const latin: number = (trimmed.match(/[a-z\u00c0-\u024f\u1e00-\u1eff]/gi) ?? []).length;
      const letters: number = (trimmed.match(/\p{L}/gu) ?? []).length;
      const other: number = Math.max(0, letters - kana - hangul - han - latin);
      if (kana > 0 && kana + han > latin && kana + han > hangul && kana + han > other) {
        code = 'ja';
      } else if (hangul > latin && hangul > han && hangul > other) {
        code = 'ko';
      } else if (han > latin && han > hangul && han > other) {
        code = 'zh';
      } else if (latin > 0 && latin > other) {
        const words: string[] = trimmed.toLowerCase().match(/[a-z\u00c0-\u024f\u1e00-\u1eff]+/g) ?? [];
        // Words with \u011f, \u015f, \u0131 or \u0130 count for Turkish (counted before lowercasing: '\u0130' lowercases to i + a combining dot).
        // ponytail: Azerbaijani shares these letters and reads as Turkish; a real language identifier would fix it.
        const turkishLetterWords: number = (trimmed.match(/\p{L}*[\u011f\u011e\u015f\u015e\u0131\u0130]\p{L}*/gu) ?? []).length;
        let bestScore: number = 0;
        let tied: boolean = false;
        for (const clues of HeuristicLanguageDetector.LATIN_CLUES) {
          const vocabulary: string[] = clues.words.split(' ');
          let score: number = clues.code === 'tr' ? turkishLetterWords : 0;
          for (const word of words) {
            if (vocabulary.includes(word)) { score += 1; }
          }
          if (score > bestScore) {
            code = clues.code;
            bestScore = score;
            tied = false;
          } else if (score > 0 && score === bestScore) {
            tied = true;
          }
        }
        if (tied) { code = 'und'; }
      }
      if (code !== 'und') { method = 'owned-heuristic-script-or-words'; }
      // CLD3 is strong on sentences but often wrong on one word ('Hello' -> Serbian), where the word lists are right:
      // it decides text of 20 letters or more, and shorter text only when the clues above found nothing ('Selamlar').
      if (letters >= 20 || code === 'und') {
        const identified: string | undefined = HeuristicLanguageDetector.identify(trimmed);
        if (identified !== undefined) {
          code = identified;
          method = 'cld3';
        }
      }
    }
    code = HeuristicLanguageDetector.normalizeLanguageCode(code);
    const result: HeuristicLanguageDetectionResult = {
      detectedLanguageCode: code,
      // Compatibility field describes the source fallback catalog, not target model availability.
      isSupportedByAppleIntelligence: HeuristicLanguageDetector.supportedLanguageCodes().has(code),
      method: method
    };
    return result;
  }

  // CLD3's reliable guess in the app's codes; undefined when unsure, for romanized text ('ru-Latn'), or without the
  // native library (local unit tests).
  private static identify(text: string): string | undefined {
    try {
      const guess = nllb.detectLanguage(text);
      if (!guess.reliable || guess.language.includes('-')) { return undefined; }
      const renamed: Record<string, string> = { 'iw': 'he', 'fil': 'tl', 'no': 'nb' };
      return renamed[guess.language] ?? guess.language;
    } catch (error) {
      return undefined;
    }
  }

  private static supportedLanguageCodes(): Set<string> {
    return HeuristicLanguageDetector.FALLBACK_SUPPORTED_LANGUAGE_CODES;
  }

  private static normalizeLanguageCode(raw: string): string {
    return raw.toLowerCase().split('-')[0] || raw.toLowerCase();
  }
}

export class RawInputSegmenter {
  static segment(text: string): SegmentationResult {
    const result: SegmentationResult = {
      segments: trimWhitespace(text).length === 0 ? [] : [new TextSegment(0, text)],
      joinersAfter: trimWhitespace(text).length === 0 ? [] : ['']
    };
    return result;
  }
}

export class SentenceSegmenter {
  static segment(text: string, usesAITranslation: boolean): SegmentationResult {
    if (trimWhitespace(text).length === 0) {
      const empty: SegmentationResult = { segments: [], joinersAfter: [] };
      return empty;
    }
    const limits: SegmentationLimits = SentenceSegmenter.segmentationLimits(usesAITranslation);
    return SentenceSegmenter.groupedSegments(SentenceSegmenter.sentenceUnits(text),
      limits.maxCharacters, limits.maxWords);
  }

  private static segmentationLimits(usesAITranslation: boolean): SegmentationLimits {
    const limits: SegmentationLimits = {
      maxCharacters: usesAITranslation ? 280 : 140,
      maxWords: usesAITranslation ? 120 : 90
    };
    return limits;
  }

  private static sentenceUnits(text: string): SentenceUnit[] {
    // shortcut: punctuation/newline boundaries replace NLTokenizer; linguistic abbreviation parity needs a verified tokenizer.
    const units: SentenceUnit[] = [];
    let start: number = 0;
    let cursor: number = 0;
    while (cursor < text.length) {
      const char: string = text.charAt(cursor);
      let boundary: boolean = /[。！？!?\r\n\u2028\u2029]/.test(char);
      if (char === '.') {
        const before: string = text.slice(start, cursor);
        const isDecimal: boolean = /[0-9]$/.test(before) && /[0-9]/.test(text.charAt(cursor + 1));
        const isAbbreviation: boolean = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-Za-z])$/i.test(before);
        boundary = !isDecimal && !isAbbreviation &&
          (cursor + 1 === text.length || /[\p{White_Space}.\u0022'”’\])}」』]/u.test(text.charAt(cursor + 1)));
      }
      cursor += 1;
      if (!boundary) { continue; }
      let end: number = cursor;
      if (/\p{White_Space}/u.test(char)) { end -= 1; }
      while (end > start && /\p{White_Space}/u.test(text.charAt(end - 1))) { end -= 1; }
      if (!/\p{White_Space}/u.test(char)) {
        while (cursor < text.length && /[.!?。！？\u0022'”’\])}」』]/.test(text.charAt(cursor))) {
          cursor += 1;
          end = cursor;
        }
      }
      while (cursor < text.length && /\p{White_Space}/u.test(text.charAt(cursor))) { cursor += 1; }
      if (end > start) {
        const unit: SentenceUnit = { text: text.slice(start, end), joinerAfter: text.slice(end, cursor) };
        units.push(unit);
        start = cursor;
      }
    }
    if (start < text.length) {
      let end: number = text.length;
      while (end > start && /\p{White_Space}/u.test(text.charAt(end - 1))) { end -= 1; }
      if (end > start) {
        const tail: SentenceUnit = { text: text.slice(start, end), joinerAfter: text.slice(end) };
        units.push(tail);
      } else if (units.length > 0) {
        units[units.length - 1].joinerAfter += text.slice(start);
      }
    }
    if (units.length === 0) {
      const whole: SentenceUnit = { text: text, joinerAfter: '' };
      units.push(whole);
    }
    return units;
  }

  private static groupedSegments(units: SentenceUnit[], maxCharacters: number, maxWords: number): SegmentationResult {
    const segments: TextSegment[] = [];
    const joinersAfter: string[] = [];
    let start: number = 0;
    while (start < units.length) {
      let end: number = start;
      while (end < units.length) {
        const candidate: string = SentenceSegmenter.composeSegmentText(units, start, end);
        // shortcut: Unicode scalar count approximates Swift grapheme count; upgrade for combining/ZWJ-heavy limit parity.
        const exceeds: boolean = Array.from(candidate).length > maxCharacters ||
          SentenceSegmenter.wordCount(candidate) > maxWords;
        if (exceeds && end > start) { break; }
        end += 1;
        if (exceeds) { break; }
      }
      const safeEnd: number = Math.max(start + 1, end);
      segments.push(new TextSegment(segments.length, SentenceSegmenter.composeSegmentText(units, start, safeEnd - 1)));
      joinersAfter.push(units[safeEnd - 1].joinerAfter);
      start = safeEnd;
    }
    return SentenceSegmenter.normalizedSegmentationResult(segments, joinersAfter);
  }

  private static composeSegmentText(units: SentenceUnit[], start: number, end: number): string {
    let result: string = '';
    for (let index: number = start; index <= end; index += 1) {
      result += units[index].text;
      if (index < end) { result += units[index].joinerAfter; }
    }
    return result;
  }

  private static wordCount(line: string): number {
    return trimWhitespace(line).length === 0 ? 0 : trimWhitespace(line).split(/\p{White_Space}+/u).length;
  }

  private static normalizedSegmentationResult(segments: TextSegment[], joinersAfter: string[]): SegmentationResult {
    const normalizedSegments: TextSegment[] = [];
    const normalizedJoiners: string[] = [];
    let leadingWhitespaceBuffer: string = '';
    for (let index: number = 0; index < segments.length; index += 1) {
      const segment: TextSegment = segments[index];
      const joiner: string = index < joinersAfter.length ? joinersAfter[index] : '';
      if (trimWhitespace(segment.text).length === 0) {
        const carried: string = segment.text + joiner;
        if (normalizedJoiners.length > 0) {
          normalizedJoiners[normalizedJoiners.length - 1] += carried;
        } else {
          leadingWhitespaceBuffer += carried;
        }
        continue;
      }
      normalizedSegments.push(new TextSegment(normalizedSegments.length, leadingWhitespaceBuffer + segment.text, segment.kind));
      leadingWhitespaceBuffer = '';
      normalizedJoiners.push(joiner);
    }
    if (leadingWhitespaceBuffer.length > 0 && normalizedJoiners.length > 0) {
      normalizedJoiners[normalizedJoiners.length - 1] += leadingWhitespaceBuffer;
    }
    const result: SegmentationResult = { segments: normalizedSegments, joinersAfter: normalizedJoiners };
    return result;
  }
}

export class ProtectedTokenExtractor {
  private static readonly URL_REGEX: RegExp = /https?:\/\/\P{White_Space}+/gu;
  private static readonly FILE_PATH_REGEX: RegExp = /(?:~?\/)?(?:[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200c\u200d.-]+\/)+[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200c\u200d.-]+/gu;
  private static readonly CODE_REGEX: RegExp = /`[^`]+`/gu;
  private static readonly NUMBER_REGEX: RegExp = /\p{Nd}+(?:[.,]\p{Nd}+)?(?![\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Cf}])/gu;
  private static readonly PROPER_NOUN_REGEX: RegExp = /[A-Z][a-zA-Z]+/gu;

  static extract(text: string): ProtectedToken[] {
    const urls: ProtectedToken[] = ProtectedTokenExtractor.matches(ProtectedTokenExtractor.URL_REGEX, text, ProtectedTokenKind.URL);
    const paths: ProtectedToken[] = ProtectedTokenExtractor.matches(ProtectedTokenExtractor.FILE_PATH_REGEX, text, ProtectedTokenKind.FILE_PATH);
    const code: ProtectedToken[] = ProtectedTokenExtractor.matches(ProtectedTokenExtractor.CODE_REGEX, text, ProtectedTokenKind.CODE_SNIPPET);
    const numbers: ProtectedToken[] = ProtectedTokenExtractor.matches(ProtectedTokenExtractor.NUMBER_REGEX, text, ProtectedTokenKind.NUMBER);
    const names: ProtectedToken[] = ProtectedTokenExtractor.matches(ProtectedTokenExtractor.PROPER_NOUN_REGEX, text, ProtectedTokenKind.PROPER_NOUN_CANDIDATE);
    const tokens: ProtectedToken[] = urls.concat(paths, code, numbers, names);
    return tokens.sort((a: ProtectedToken, b: ProtectedToken): number => a.range.start - b.range.start);
  }

  private static matches(regex: RegExp, text: string, kind: ProtectedTokenKind): ProtectedToken[] {
    const matches: ProtectedToken[] = [];
    regex.lastIndex = 0;
    let match: RegExpExecArray | null = regex.exec(text);
    while (match !== null) {
      const range: TextRange = { start: match.index, end: match.index + match[0].length };
      if ((kind !== ProtectedTokenKind.NUMBER && kind !== ProtectedTokenKind.PROPER_NOUN_CANDIDATE) ||
        (GlossaryMatcher.isWordBoundary(text, range.start) && GlossaryMatcher.isWordBoundary(text, range.end))) {
        matches.push(new ProtectedToken(kind, match[0], range));
      } else if (kind === ProtectedTokenKind.NUMBER) {
        const separator: number = match[0].search(/[.,]/);
        if (separator >= 0) { regex.lastIndex = match.index + separator + 1; }
      }
      match = regex.exec(text);
    }
    return matches;
  }
}

export class GlossaryMatcher {
  static match(glossary: GlossaryEntry[], text: string): GlossaryMatch[] {
    const matches: GlossaryMatch[] = [];
    for (const entry of glossary) {
      if (entry.source.length === 0) { continue; }
      const escaped: string = entry.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // shortcut: ES RegExp lacks ICU multi-character case folding; upgrade for glossary cases such as STRASSE/straße.
      const regex: RegExp = new RegExp(escaped, 'giu');
      let match: RegExpExecArray | null = regex.exec(text);
      while (match !== null) {
        const range: TextRange = { start: match.index, end: match.index + match[0].length };
        if (GlossaryMatcher.isWordBoundary(text, range.start) && GlossaryMatcher.isWordBoundary(text, range.end)) {
          matches.push(new GlossaryMatch(entry.source, entry.target, range));
        } else {
          const first: string[] = Array.from(match[0].slice(0, 2));
          regex.lastIndex = match.index + first[0].length;
        }
        match = regex.exec(text);
      }
    }
    return matches.sort((a: GlossaryMatch, b: GlossaryMatch): number => a.range.start - b.range.start);
  }

  static isWordBoundary(text: string, offset: number): boolean {
    const after: string[] = Array.from(text.slice(offset, offset + 2));
    if (after.length > 0 && /[\p{M}\p{Cf}]/u.test(after[0])) { return false; }
    let cursor: number = offset;
    let before: string = '';
    while (cursor > 0) {
      const previous: string[] = Array.from(text.slice(Math.max(0, cursor - 2), cursor));
      before = previous[previous.length - 1];
      if (!/[\p{M}\p{Cf}]/u.test(before)) { break; }
      cursor -= before.length;
      before = '';
    }
    const isWordBefore: boolean = /[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200c\u200d]/u.test(before);
    const isWordAfter: boolean = after.length > 0 && /[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200c\u200d]/u.test(after[0]);
    return isWordBefore !== isWordAfter;
  }
}

export class AmbiguityHintDetector {
  static detect(text: string): AmbiguityHint[] {
    const hints: AmbiguityHint[] = [];
    const lowered: string = text.toLowerCase();
    if (lowered.includes(' it ') || lowered.startsWith('it ') || lowered.endsWith(' it')) {
      hints.push(new AmbiguityHint('pronoun', "Pronoun 'it' may require explicit referent in target language."));
    }
    if (lowered.includes('they')) {
      hints.push(new AmbiguityHint('pronoun', "Pronoun 'they' can be singular or plural."));
    }
    if (lowered.includes('you')) {
      hints.push(new AmbiguityHint('register', "Pronoun 'you' can require politeness choice."));
    }
    return hints;
  }
}

export class FormattingInspector {
  static inspect(text: string): FormattingProfile {
    const profile: FormattingProfile = {
      leadingWhitespace: text.match(/^\p{White_Space}*/u)?.[0] ?? '',
      trailingWhitespace: text.match(/\p{White_Space}*$/u)?.[0] ?? '',
      newlineCount: (text.match(/(?<!\r)\n/g) ?? []).length
    };
    return profile;
  }
}
