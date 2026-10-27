import { i18n } from '@kit.LocalizationKit';
import { TargetLanguageOption } from '../model/TranslationModels';

export class AppleIntelligenceLanguageCatalog {
  private static readonly FALLBACK_LANGUAGE_CODES: string[] = [
    'da', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nb', 'nl', 'pt', 'sv', 'tr', 'vi', 'zh'
  ];
  private static readonly TRANSLATION_FRAMEWORK_FALLBACK_LANGUAGE_CODES: string[] = [
    'ar', 'de', 'en', 'en-GB', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt',
    'ru', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-Hant'
  ];
  private static runtimeLanguageCodes: string[] = [];

  // The selected model owner supplies genuine runtime codes; the catalog itself claims no engine availability.
  static configureSupportedLanguageCodes(codes: string[]): void {
    const normalized: string[] = codes.map((code: string) => code.split('-')[0].toLowerCase())
      .filter((code: string) => /^[a-z]{2,3}$/.test(code));
    this.runtimeLanguageCodes = Array.from(new Set<string>(normalized)).sort();
  }

  static supportedLanguageOptions(locale: string = i18n.System.getSystemLocale()): TargetLanguageOption[] {
    return this.foundationModelsSupportedLanguageCodes().map((code: string) =>
      new TargetLanguageOption(code, this.localizedLanguageName(code, locale), this.nativeLanguageName(code)));
  }

  static translationFrameworkLanguageOptions(locale: string = i18n.System.getSystemLocale()): TargetLanguageOption[] {
    return this.TRANSLATION_FRAMEWORK_FALLBACK_LANGUAGE_CODES.map((code: string) =>
      new TargetLanguageOption(code, this.localizedLanguageName(code, locale), this.nativeLanguageName(code)));
  }

  private static localizedLanguageName(code: string, locale: string): string {
    try {
      const name: string = i18n.System.getDisplayLanguage(code, locale, false);
      if (name.length > 0 && name !== code) {
        return name;
      }
      return i18n.System.getDisplayLanguage(code.split('-')[0], locale, false) || code;
    } catch (error) {
      return code;
    }
  }

  private static nativeLanguageName(code: string): string {
    return this.localizedLanguageName(code, code);
  }

  private static foundationModelsSupportedLanguageCodes(): string[] {
    return this.runtimeLanguageCodes.length > 0 ? this.runtimeLanguageCodes : this.FALLBACK_LANGUAGE_CODES;
  }
}
