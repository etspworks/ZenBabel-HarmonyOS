import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import nllb from 'libnllb_napi.so';
import { HeuristicLanguageDetector } from './PreprocessEngine';
import {
  RecoveryAvailabilityStatus, RecoveryCancellation, RecoveryLanguageAvailability, RecoveryTranslationError,
  RecoveryTranslationErrorKind, RecoveryTranslationRequest, RecoveryTranslationResponse, RecoveryTranslationSession
} from './UnsafeRecovery';

// App/ISO 639 language codes -> NLLB-200 language tokens: the target menu's languages, plus the other source
// languages CLD3 can identify that NLLB has.
const NLLB_CODES: Record<string, string> = {
  'af': 'afr_Latn', 'am': 'amh_Ethi', 'ar': 'arb_Arab', 'az': 'azj_Latn', 'be': 'bel_Cyrl', 'bg': 'bul_Cyrl',
  'bn': 'ben_Beng', 'bs': 'bos_Latn', 'ca': 'cat_Latn', 'ceb': 'ceb_Latn', 'cs': 'ces_Latn', 'cy': 'cym_Latn',
  'da': 'dan_Latn', 'de': 'deu_Latn', 'el': 'ell_Grek', 'en': 'eng_Latn', 'eo': 'epo_Latn', 'es': 'spa_Latn',
  'et': 'est_Latn', 'eu': 'eus_Latn', 'fa': 'pes_Arab', 'fi': 'fin_Latn', 'fr': 'fra_Latn', 'ga': 'gle_Latn',
  'gd': 'gla_Latn', 'gl': 'glg_Latn', 'gu': 'guj_Gujr', 'ha': 'hau_Latn', 'he': 'heb_Hebr', 'hi': 'hin_Deva',
  'hr': 'hrv_Latn', 'ht': 'hat_Latn', 'hu': 'hun_Latn', 'hy': 'hye_Armn', 'id': 'ind_Latn', 'ig': 'ibo_Latn',
  'is': 'isl_Latn', 'it': 'ita_Latn', 'ja': 'jpn_Jpan', 'jv': 'jav_Latn', 'ka': 'kat_Geor', 'kk': 'kaz_Cyrl',
  'km': 'khm_Khmr', 'kn': 'kan_Knda', 'ko': 'kor_Hang', 'ku': 'kmr_Latn', 'ky': 'kir_Cyrl', 'lb': 'ltz_Latn',
  'lo': 'lao_Laoo', 'lt': 'lit_Latn', 'lv': 'lvs_Latn', 'mg': 'plt_Latn', 'mi': 'mri_Latn', 'mk': 'mkd_Cyrl',
  'ml': 'mal_Mlym', 'mn': 'khk_Cyrl', 'mr': 'mar_Deva', 'ms': 'zsm_Latn', 'mt': 'mlt_Latn', 'my': 'mya_Mymr',
  'nb': 'nob_Latn', 'ne': 'npi_Deva', 'nl': 'nld_Latn', 'ny': 'nya_Latn', 'pa': 'pan_Guru', 'pl': 'pol_Latn',
  'ps': 'pbt_Arab', 'pt': 'por_Latn', 'ro': 'ron_Latn', 'ru': 'rus_Cyrl', 'sd': 'snd_Arab', 'si': 'sin_Sinh',
  'sk': 'slk_Latn', 'sl': 'slv_Latn', 'sm': 'smo_Latn', 'sn': 'sna_Latn', 'so': 'som_Latn', 'sq': 'als_Latn',
  'sr': 'srp_Cyrl', 'st': 'sot_Latn', 'su': 'sun_Latn', 'sv': 'swe_Latn', 'sw': 'swh_Latn', 'ta': 'tam_Taml',
  'te': 'tel_Telu', 'tg': 'tgk_Cyrl', 'th': 'tha_Thai', 'tl': 'tgl_Latn', 'tr': 'tur_Latn', 'uk': 'ukr_Cyrl',
  'ur': 'urd_Arab', 'uz': 'uzn_Latn', 'vi': 'vie_Latn', 'xh': 'xho_Latn', 'yi': 'ydd_Hebr', 'yo': 'yor_Latn',
  'zu': 'zul_Latn'
};
const SUPPORTED: Set<string> = new Set<string>(Object.values(NLLB_CODES).concat(['zho_Hans', 'zho_Hant']));

/** The language pair a session works on, in app/TF codes (en-US, zh-Hant, de...); undefined = unknown. */
export interface NllbPair {
  source?: string;
  target?: string;
}

// The bundled NLLB-200 model (resources/resfile/nllb, fetched at build time by entry/hvigorfile.ts). It is loaded on
// first use and stays loaded; one model translates every pair directly.
export class NllbModel {
  private context?: common.Context;
  private handle?: Promise<number>;

  initialize(context: common.Context): void {
    this.context = context;
    // Language packs of the bergamot engine that earlier versions downloaded.
    fileIo.rmdir(`${context.filesDir}/bergamot`).catch(() => {});
  }

  /**
   * App/TF language code (en-US, zh-Hant, nb, ...) -> NLLB token (eng_Latn, zho_Hant, nob_Latn), undefined for und.
   * A language NLLB lacks comes back as its plain code, which supports() rejects.
   */
  static code(language: string | undefined): string | undefined {
    const normalized: string = (language ?? '').trim().toLowerCase().replace(/_/g, '-');
    if (normalized.length === 0 || normalized === 'und') {
      return undefined;
    }
    if (normalized.startsWith('zh')) {
      return /(hant|tw|hk|mo)/.test(normalized) ? 'zho_Hant' : 'zho_Hans';
    }
    const base: string = normalized.split('-')[0];
    return NLLB_CODES[base] ?? base;
  }

  static supports(code: string): boolean {
    return SUPPORTED.has(code);
  }

  load(): Promise<number> {
    if (this.handle === undefined) {
      if (this.context === undefined) {
        throw new Error('NllbModel used before initialize()');
      }
      this.handle = nllb.loadModel(`${this.context.resourceDir}/nllb`);
      this.handle.catch(() => { this.handle = undefined; });
    }
    return this.handle;
  }

  async translate(texts: string[], source: string, target: string, cancellation: RecoveryCancellation): Promise<string[]> {
    const handle: number = await this.load();
    const stop = (): void => { nllb.cancel(handle); };
    cancellation.addListener(stop);
    try {
      return await nllb.translate(handle, texts, source, target);
    } finally {
      cancellation.removeListener(stop);
    }
  }
}

class NllbAvailability implements RecoveryLanguageAvailability {
  async status(sourceLanguage: string | undefined, targetLanguage: string | undefined,
    cancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus> {
    const source: string | undefined = NllbModel.code(sourceLanguage);
    const target: string | undefined = NllbModel.code(targetLanguage);
    if (source !== undefined && target !== undefined && source === target) {
      return RecoveryAvailabilityStatus.UNSUPPORTED;
    }
    const codes: string[] = [source, target].filter((code: string | undefined): boolean => code !== undefined) as string[];
    if (codes.length === 0) {
      return RecoveryAvailabilityStatus.UNKNOWN;
    }
    return codes.every((code: string) => NllbModel.supports(code)) ?
      RecoveryAvailabilityStatus.INSTALLED : RecoveryAvailabilityStatus.UNSUPPORTED;
  }

  async statusForText(sourceText: string, targetLanguage: string | undefined,
    cancellation: RecoveryCancellation): Promise<RecoveryAvailabilityStatus> {
    return this.status(NllbSession.detect(sourceText), targetLanguage, cancellation);
  }
}

// The port's stand-in for an iOS TranslationSession (Apple Translation framework), backed by NLLB-200 on MindSpore Lite.
export class NllbSession implements RecoveryTranslationSession {
  readonly availability: RecoveryLanguageAvailability = new NllbAvailability();
  private model: NllbModel;
  private pair: () => NllbPair | undefined;

  constructor(model: NllbModel, pair: () => NllbPair | undefined) {
    this.model = model;
    this.pair = pair;
  }

  static detect(text: string): string | undefined {
    return NllbModel.code(HeuristicLanguageDetector.detectLanguage(text).detectedLanguageCode);
  }

  // As iOS prepareTranslation(): every language ships with the app, so this only loads the model.
  async prepareTranslation(cancellation: RecoveryCancellation): Promise<void> {
    await this.model.load();
  }

  async translations(requests: RecoveryTranslationRequest[],
    cancellation: RecoveryCancellation): Promise<RecoveryTranslationResponse[]> {
    const pair: NllbPair = this.pair() ?? {};
    const target: string | undefined = NllbModel.code(pair.target);
    if (target === undefined || !NllbModel.supports(target)) {
      throw new RecoveryTranslationError('Unsupported target language.', RecoveryTranslationErrorKind.UNSUPPORTED_TARGET_LANGUAGE);
    }
    // iOS lets the Translation framework identify an unknown source; HarmonyOS has no language identifier and the
    // heuristic detector misses short text ('One Two Three'), so an undetermined source is taken as English.
    // ponytail: English guess for undetected text; use a real language identifier if one becomes available.
    const detected: string | undefined = NllbModel.code(pair.source) ??
      NllbSession.detect(requests.map((request: RecoveryTranslationRequest) => request.sourceText).join('\n'));
    const source: string = detected !== undefined && NllbModel.supports(detected) ? detected : 'eng_Latn';
    let texts: string[] = requests.map((request: RecoveryTranslationRequest) => request.sourceText);
    // Same language in another variant (en-GB -> en-US): nothing to translate.
    if (source !== target) {
      cancellation.check();
      texts = await this.model.translate(texts, source, target, cancellation);
    }
    cancellation.check();
    return requests.map((request: RecoveryTranslationRequest, index: number) => {
      const response: RecoveryTranslationResponse = { targetText: texts[index], clientIdentifier: request.clientIdentifier };
      return response;
    });
  }
}
