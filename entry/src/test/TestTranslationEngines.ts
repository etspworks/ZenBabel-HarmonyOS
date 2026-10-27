import { TranslationInput, TextSegment, SegmentOutput } from '../main/ets/model/TranslationModels';
import { TranslationEngine } from '../main/ets/common/TranslationProtocols';

// Source-owned fixtures have no production registration; retain their literal names and tags here.
export class IdentityTranslationEngine implements TranslationEngine {
  readonly name: string = 'identity-placeholder';
  async translate(input: TranslationInput): Promise<SegmentOutput[]> {
    const segments = input.segments.length === 0 ? [new TextSegment(0, input.originalText)] : input.segments;
    return segments.map((segment: TextSegment) => new SegmentOutput(segment.index, segment.text, segment.text));
  }
}

export class StubFoundationModelsTranslationEngine implements TranslationEngine {
  readonly name: string = 'foundation-models-stub';
  async translate(input: TranslationInput): Promise<SegmentOutput[]> {
    const segments = input.segments.length === 0 ? [new TextSegment(0, input.originalText)] : input.segments;
    return segments.map((segment: TextSegment) => new SegmentOutput(segment.index, segment.text, `[FM: ${input.targetLanguage}] ${segment.text}`));
  }
}

export class StubCoreMLTranslationEngine implements TranslationEngine {
  readonly name: string = 'coreml-stub';
  async translate(input: TranslationInput): Promise<SegmentOutput[]> {
    const segments = input.segments.length === 0 ? [new TextSegment(0, input.originalText)] : input.segments;
    return segments.map((segment: TextSegment) => new SegmentOutput(segment.index, segment.text, `[CoreML: ${input.targetLanguage}] ${segment.text}`));
  }
}
