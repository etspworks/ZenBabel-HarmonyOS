@Component
export struct InteractiveSymbolButtonBody {
  @Prop label: string = '';
  @Prop isEnabled: boolean = true;

  private glyphSize(): number { return this.label === 'Copy output' ? 16 : this.isEnabled ? 20 : 15; }
  private tint(): ResourceColor { return this.isEnabled ? $r('sys.color.font_secondary') : $r('sys.color.font_tertiary'); }
  private exportedGlyph(): Resource {
    if (this.label === 'Album') return $r('app.media.ic_photo_on_rectangle_angled');
    if (this.label === 'Paste') return $r('app.media.ic_doc_on_clipboard');
    return $r('app.media.ic_doc_on_doc');
  }

  build() {
    Row() {
      if (this.label === 'Files' || this.label === 'Clear') {
        SymbolGlyph(this.label === 'Files' ? $r('sys.symbol.folder') : $r('sys.symbol.trash'))
          .fontSize(this.glyphSize()).fontWeight(FontWeight.Medium).fontColor([this.tint()]).accessibilityLevel('no')
      } else if (this.label === 'Album' || this.label === 'Paste' || this.label === 'Copy output') {
        Image(this.exportedGlyph()).width(this.glyphSize() * 1.25).height(this.glyphSize() * 1.25)
          .objectFit(ImageFit.Contain).fillColor(this.tint()).accessibilityLevel('no')
      } else {
        Text(this.label).fontColor(this.tint()).fontSize($r('sys.float.ohos_id_text_size_body2'))
      }
    }
    .justifyContent(FlexAlign.Center).alignItems(VerticalAlign.Center)
    // A constant slot (only the glyph shrinks when disabled), so the toolbar keeps its width.
    .width(this.label === 'Copy output' ? 34 : 60)
    .height(34)
    .enabled(this.isEnabled).accessibilityText(this.label)
  }
}
