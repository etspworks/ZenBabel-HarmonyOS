import { InteractiveSymbolButtonBody } from './InteractiveSymbolButtonBody';

@Component
export struct InteractiveSymbolButtonStyle {
  @Prop label: string = '';
  @Prop isEnabled: boolean = true;

  build() {
    InteractiveSymbolButtonBody({ label: this.label, isEnabled: this.isEnabled })
  }
}
