import { RecoveryConfiguration } from '../common/UnsafeRecovery';

@Component
export struct TranslationUnsafeRecoveryTaskHost {
  @Prop configuration?: RecoveryConfiguration;
  @Prop generation: string = '';

  build() {
    // Phase-2 owns pending recovery completion; no Apple session is fabricated.
    Row().width(0).height(0).id(this.generation)
  }
}
