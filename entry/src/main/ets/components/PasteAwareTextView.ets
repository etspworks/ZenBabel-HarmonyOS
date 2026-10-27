import { LengthMetrics, ColorMetrics } from '@kit.ArkUI';
import { text as graphicsText } from '@kit.ArkGraphics2D';
import { NSRange } from '../model/TranslationModels';

// iOS justifies both panes (paragraph.alignment = .justified). HarmonyOS justify also stretches at punctuation and
// inside CJK words ('paresseux .', '読 み'), so text that is mostly Chinese/Japanese/Korean is left-aligned
// (it wraps almost flush anyway) and other text stays justified.
// ponytail: justified Latin lines that must stretch still get small gaps before punctuation; platform limit.
export function editorTextAlign(value: string): TextAlign {
  const cjk: number = (value.match(/[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g) ?? []).length;
  const letters: number = (value.match(/\p{L}/gu) ?? []).length;
  return letters > 0 && cjk * 2 > letters ? TextAlign.Start : TextAlign.JUSTIFY;
}

@Component
export struct PasteAwareTextView {
  @Prop @Watch('syncText') text: string = '';
  @Prop placeholder: string = '';
  @Prop @Watch('syncHighlight') highlightedRange?: NSRange;
  @Prop fontPointSize: number = 16;
  @Prop additionalTopInset: number = 0;
  @Prop additionalBottomInset: number = 0;
  @Prop @Watch('syncHighlight') fontScaleMultiplier: number = 1;
  @Prop @Watch('syncHighlight') centerOnHighlightIfNeeded: boolean = false;
  @Prop topAlignOnHighlightScroll: boolean = true;
  controller: RichEditorController = new RichEditorController();
  onTextChanged?: (text: string) => void;
  onCursorLocationChanged?: (location: number) => void;
  onPaste?: (event: PasteEvent) => void;
  onEditingStarted?: () => void;
  onEditingEnded?: () => void;
  private scroller: Scroller = new Scroller();
  private ready: boolean = false;
  private updating: boolean = false;
  private previewing: boolean = false;
  private layoutTask?: number;
  private correctionTask?: number;
  private viewportHeight: number = 0;
  @State private editorHeight: number = 0;

  aboutToDisappear(): void {
    this.ready = false;
    if (this.layoutTask !== undefined) clearTimeout(this.layoutTask);
    if (this.correctionTask !== undefined) clearTimeout(this.correctionTask);
  }

  private placeholderColor(): ResourceColor {
    const color: ColorMetrics = ColorMetrics.resourceColor($r('sys.color.font_secondary'));
    return ColorMetrics.rgba(color.red, color.green, color.blue, color.alpha / 255 * 0.85).color;
  }

  private nativeText(): string {
    return this.controller.toStyledString({}).getString();
  }

  private syncText(): void {
    if (!this.ready || this.previewing || this.updating) return;
    if (this.nativeText() !== this.text) {
      const selection: RichEditorSelection = this.controller.getSelection();
      this.updating = true;
      try {
        this.controller.deleteSpans();
        if (this.text.length > 0) this.controller.addTextSpan(this.text);
        const start: number = Math.max(0, Math.min(this.text.length, selection.selection[0]));
        const end: number = Math.max(start, Math.min(this.text.length, selection.selection[1]));
        this.controller.setSelection(start, end, { menuPolicy: MenuPolicy.HIDE });
        this.controller.setCaretOffset(start);
      } finally { this.updating = false; }
    }
    this.syncHighlight();
  }

  private syncHighlight(): void {
    if (!this.ready || this.previewing || this.updating) return;
    this.updating = true;
    try {
      const length: number = this.nativeText().length;
      if (length > 0) {
        this.controller.updateSpanStyle({ start: 0, end: length,
          textStyle: { fontSize: this.fontPointSize * this.fontScaleMultiplier, fontColor: $r('sys.color.font_primary'), textBackgroundStyle: { color: Color.Transparent } } });
        this.controller.updateParagraphStyle({ start: 0, end: length, style: { textAlign: editorTextAlign(this.nativeText()) } });
        const range: NSRange | undefined = this.highlightedRange;
        if (range && range.location >= 0 && range.length > 0 && range.location + range.length <= length) {
          this.controller.updateSpanStyle({ start: range.location, end: range.location + range.length,
            textStyle: { textBackgroundStyle: { color: '#66FFBE38' } } });
        }
      }
    } finally { this.updating = false; }
    this.scheduleLayout();
  }

  private scheduleLayout(): void {
    if (this.layoutTask !== undefined) clearTimeout(this.layoutTask);
    this.layoutTask = setTimeout(() => {
      this.layoutTask = undefined;
      if (!this.ready || this.previewing) return;
      const layout: LayoutManager = this.controller.getLayoutManager();
      const count: number = layout.getLineCount();
      if (count > 0) {
        const last: graphicsText.LineMetrics = layout.getLineMetrics(count - 1);
        const height: number = Math.max(this.viewportHeight, this.getUIContext().px2vp(last.baseline + last.descent));
        if (height !== this.editorHeight) this.editorHeight = height;
      } else { this.editorHeight = this.viewportHeight; }
      this.scrollHighlight(false);
      if (this.correctionTask !== undefined) clearTimeout(this.correctionTask);
      if (this.centerOnHighlightIfNeeded) {
        this.correctionTask = setTimeout(() => {
          this.correctionTask = undefined;
          if (this.ready && !this.previewing) this.scrollHighlight(true);
        }, 240);
      }
    }, 0);
  }

  private scrollHighlight(force: boolean): void {
    const range: NSRange | undefined = this.highlightedRange;
    if (!this.centerOnHighlightIfNeeded || !range || range.length <= 0 ||
      range.location < 0 || range.location + range.length > this.nativeText().length) return;
    const boxes: graphicsText.TextBox[] = this.controller.getLayoutManager().getRectsForRange(
      { start: range.location, end: range.location + range.length }, graphicsText.RectWidthStyle.TIGHT, graphicsText.RectHeightStyle.TIGHT);
    if (boxes.length === 0) return;
    const top: number = this.getUIContext().px2vp(boxes[0].rect.top);
    const bottom: number = this.getUIContext().px2vp(boxes[boxes.length - 1].rect.bottom);
    const offset: number = this.scroller.currentOffset().yOffset;
    if (!force && !this.topAlignOnHighlightScroll && bottom >= offset && top <= offset + this.viewportHeight) return;
    const y: number = this.topAlignOnHighlightScroll ? top : (top + bottom - this.viewportHeight) / 2;
    this.scroller.scrollTo({ xOffset: 0, yOffset: Math.max(0, Math.min(y, this.editorHeight - this.viewportHeight)), animation: false });
  }

  private textChanged(): void {
    if (!this.ready || this.previewing || this.updating) return;
    const text: string = this.nativeText();
    this.onTextChanged?.(text);
    this.onCursorLocationChanged?.(this.controller.getCaretOffset());
    this.syncHighlight();
  }

  build() {
    // The placeholder is an overlay, as on iOS: RichEditor's own placeholder hides as soon as the
    // editor holds whitespace, but the source shows it until the trimmed input is non-empty.
    Stack({ alignContent: Alignment.TopStart }) {
      Scroll(this.scroller) {
        RichEditor({ controller: this.controller })
          .id('translation_source_input')
          .width('100%').height(this.editorHeight)
          .enablePreviewText(true)
          .backgroundColor(Color.Transparent)
          .padding({ start: LengthMetrics.vp(0), end: LengthMetrics.vp(0), top: LengthMetrics.vp((this.text.trim().length === 0 ? 14 : 6) + this.additionalTopInset), bottom: LengthMetrics.vp(6 + this.additionalBottomInset)})
          .onReady(() => { this.ready = true; this.syncText(); })
          .onWillChange((change: RichEditorChangeValue) => {
            this.previewing = change.replacedSpans.some((span: RichEditorTextSpanResult) => (span.previewText ?? '').length > 0);
            return change.replacedImageSpans.length === 0 && change.replacedSymbolSpans.length === 0;
          })
          .onIMEInputComplete((span: RichEditorTextSpanResult) => {
            this.previewing = (span.previewText ?? '').length > 0;
            if (!this.previewing) this.textChanged();
          })
          .onDidChange(() => { this.textChanged(); })
          .onSelectionChange((range: RichEditorRange) => {
            if (!this.previewing && !this.updating) this.onCursorLocationChanged?.(range.start ?? 0);
          })
          .onPaste((event: PasteEvent) => { this.onPaste?.(event); })
          .onEditingChange((editing: boolean) => {
            if (editing) this.onEditingStarted?.();
            else { this.previewing = false; this.textChanged(); this.syncText(); this.onEditingEnded?.(); }
          })
      }
      .width('100%').height('100%')
      .onAreaChange((oldArea: Area, area: Area) => {
        this.viewportHeight = Number(area.height);
        this.scheduleLayout();
      })
      if (this.placeholder.length > 0 && this.text.trim().length === 0) {
        Text(this.placeholder)
          .fontSize(this.fontPointSize * this.fontScaleMultiplier)
          .fontColor(this.placeholderColor())
          .padding({ top: 14 + this.additionalTopInset })
          .hitTestBehavior(HitTestMode.None)
      }
    }
    .width('100%').height('100%')
  }
}
