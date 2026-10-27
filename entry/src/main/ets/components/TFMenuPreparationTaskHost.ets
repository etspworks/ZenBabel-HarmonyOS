import { TFMenuPreparationConfiguration } from '../common/TranslationViewModel';

@Component
export struct TFMenuPreparationTaskHost {
  @Prop configuration?: TFMenuPreparationConfiguration;
  @Prop generation: string = '';

  build() {
    // Phase-2 owns preparation and its explicit platform-unavailable outcome.
    Row().width(0).height(0).id(this.generation)
  }
}
