import { LengthMetrics } from '@kit.ArkUI';
import { NSRange } from '../model/TranslationModels';
import { PasteAwareTextView } from './PasteAwareTextView';

@Component
export struct IOSClutchSourceTextEditor {
  @Prop text: string = '';
  @Prop highlightedRange?: NSRange;
  controller: RichEditorController = new RichEditorController();
  @Prop fontPointSize: number = 16;
  @Prop additionalTopInset: number = 0;
  @Prop additionalBottomInset: number = 0;
  @Prop fontScaleMultiplier: number = 1;
  @Prop centerOnHighlightIfNeeded: boolean = false;
  @Prop topAlignOnHighlightScroll: boolean = true;
  onTextChanged?: (text: string) => void;
  onCursorLocationChanged?: (location: number) => void;
  onPaste?: (event: PasteEvent) => void;
  onEditingStarted?: () => void;
  onEditingEnded?: () => void;

  build() {
    Column() {
      PasteAwareTextView({
        text: this.text,
        controller: this.controller,
        highlightedRange: this.highlightedRange,
        fontScaleMultiplier: this.fontScaleMultiplier,
        fontPointSize: this.fontPointSize,
        additionalTopInset: this.additionalTopInset,
        additionalBottomInset: this.additionalBottomInset,
        centerOnHighlightIfNeeded: this.centerOnHighlightIfNeeded,
        topAlignOnHighlightScroll: this.topAlignOnHighlightScroll,
        placeholder: this.text.trim().length === 0 ? 'Enter text to translate.' : '',
        onTextChanged: this.onTextChanged,
        onCursorLocationChanged: this.onCursorLocationChanged,
        onPaste: this.onPaste,
        onEditingStarted: this.onEditingStarted,
        onEditingEnded: this.onEditingEnded
      })
    }
    .id('translation_source_scroll')
    .width('100%').height('100%')
  }
}
