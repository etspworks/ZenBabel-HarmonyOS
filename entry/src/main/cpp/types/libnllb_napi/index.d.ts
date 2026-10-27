// libnllb_napi.so: NLLB on-device translation on MindSpore Lite, and CLD3 language identification
// (entry/src/main/cpp/napi_init.cpp).
/**
 * Loads the model files in dir (encoder.ms, decoder.ms, sentencepiece.bpe.model, vocab.txt, languages.txt).
 * Resolves to a handle.
 */
export const loadModel: (dir: string) => Promise<number>;
/**
 * Translates each text from source to target (NLLB codes such as 'eng_Latn', 'jpn_Jpan', 'zho_Hant'); the result has one entry per
 * input, in order. Rejects when a language is not in the model.
 */
export const translate: (handle: number, texts: string[], source: string, target: string) => Promise<string[]>;
/** Makes the running translate() of this model stop at its next token; it resolves with what it has so far. */
export const cancel: (handle: number) => void;
/** Frees a loaded model. */
export const unloadModel: (handle: number) => void;
/** CLD3's guess: an ISO 639 code ('tr', 'zh', 'iw', 'fil', 'ru-Latn' for romanized text...) or 'und'. */
export interface LanguageGuess {
  language: string;
  probability: number;
  reliable: boolean;
}
/** Identifies the language of text (its first 512 bytes) with CLD3. Synchronous and quick. */
export const detectLanguage: (text: string) => LanguageGuess;
