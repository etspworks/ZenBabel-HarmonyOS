import { text as graphicsText } from '@kit.ArkGraphics2D';
import { deviceInfo } from '@kit.BasicServicesKit';
import { window, KeyboardAvoidMode, componentUtils, LengthMetrics, ColorMetrics } from '@kit.ArkUI';
import { BusinessError, pasteboard } from '@kit.BasicServicesKit';
import { common, Want, ConfigurationConstant, systemConfiguration } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { i18n } from '@kit.LocalizationKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor } from '@kit.ArkData';
import { describeError } from '../common/ErrorText';
import { TranslationViewModel } from '../common/TranslationViewModel';
import { ImportService, ImportToastPlacement } from '../common/ImportService';
import { TargetLanguageOption, SegmentOutput, StatusNotice, TranslationExperimentMode,
  TRANSLATION_EXPERIMENT_MODES, experimentModeDisplayName } from '../model/TranslationModels';
import { TranslationViewVisualTokens as VisualTokens } from '../components/TranslationViewLayoutTokens';
import { IOSClutchSourceTextEditor } from '../components/IOSClutchSourceTextEditor';
import { editorTextAlign } from '../components/PasteAwareTextView';
import { InteractiveSymbolButtonStyle } from '../components/InteractiveSymbolButtonStyle';
import { RoundedCorner, RoundedCornerShape } from '../components/RoundedCornerShape';
import { TFMenuPreparationTaskHost } from '../components/TFMenuPreparationTaskHost';
import { TranslationUnsafeRecoveryTaskHost } from '../components/TranslationUnsafeRecoveryTaskHost';

@CustomDialog
struct TranslationUserAlert {
  controller?: CustomDialogController;
  viewModel: TranslationViewModel = AppStorage.get<TranslationViewModel>('translationViewModel')!;

  private async openSettings(): Promise<void> {
    try {
      const context: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const want: Want = {
        bundleName: 'com.huawei.hmos.settings', abilityName: 'com.huawei.hmos.settings.MainAbility',
        uri: 'application_info_entry', parameters: { pushParams: context.applicationInfo.name }
      };
      await context.startAbility(want);
      this.dismiss();
    } catch (error) {
      this.viewModel.errorMessage = describeError(error as BusinessError);
      this.viewModel.notifyStateChanged();
    }
  }

  private dismiss(): void {
    this.viewModel.dismissUserAlert();
    this.controller?.close();
  }

  build() {
    Column() {
      Text(this.viewModel.userAlert?.title ?? '').fontSize($r('sys.float.ohos_id_text_size_body1')).fontWeight(FontWeight.Medium).fontColor($r('sys.color.font_primary'))
      Text(this.viewModel.userAlert?.message ?? '').fontSize($r('sys.float.ohos_id_text_size_body2')).fontColor($r('sys.color.font_secondary'))
      if (this.viewModel.userAlert?.offersSettingsShortcut) {
        Button('Open Settings').fontColor($r('sys.color.font_emphasize')).backgroundColor(Color.Transparent).id('translation_alert_open_settings').onClick(async () => { await this.openSettings(); })
        Button('Close').fontColor($r('sys.color.font_emphasize')).backgroundColor(Color.Transparent).id('translation_alert_close').onClick(() => { this.dismiss(); })
      } else {
        Button('OK').fontColor($r('sys.color.font_emphasize')).backgroundColor(Color.Transparent).id('translation_alert_ok').onClick(() => { this.dismiss(); })
      }
    }.padding(24).backgroundColor($r('sys.color.comp_background_list_card')).borderRadius($r('sys.float.ohos_id_corner_radius_dialog'))
  }
}

@Entry
@Component
struct TranslationViewPage {
  private viewModel: TranslationViewModel = AppStorage.get<TranslationViewModel>('translationViewModel')!;
  private importService: ImportService = AppStorage.get<ImportService>('translationImportService')!;
  @State private revision: number = 0;
  @State private wideLayout: boolean = false;
  @State private pageHeight: number = 0;
  @State private colorScheme: ConfigurationConstant.ColorMode | undefined = undefined;
  private applicationContext?: common.ApplicationContext;
  private configurationUpdated: systemConfiguration.UpdatedCallback = {
    onColorModeUpdated: (mode: ConfigurationConstant.ColorMode) => { this.colorScheme = mode; }
  };
  private previousKeyboardAvoidMode?: KeyboardAvoidMode;
  @State private sourceFocused: boolean = false;
  @State private isKeyboardPresented: boolean = false;
  @State private keyboardBottomInset: number = 0;
  private keyboardHeightPx: number = 0;
  private isPadDevice: boolean = deviceInfo.deviceType === 'tablet' || deviceInfo.deviceType === '2in1';
  private hostWindow?: window.Window;
  private appeared: boolean = false;
  private keyboardHeightChanged: (height: number) => void = (height: number) => { this.updateKeyboardPresentation(height); };
  @State private pinchOverlayText: string | undefined = undefined;
  @State private pinchOverlayHost: string | undefined = undefined;
  private sourceController: RichEditorController = new RichEditorController();
  private outputScroller: Scroller = new Scroller();
  private shareController?: systemShare.ShareController;
  private shareDismissed: () => void = () => {
    this.shareController?.off('dismiss', this.shareDismissed);
    this.shareController = undefined;
    this.revision += 1;
  };
  private outputViewportHeight: number = 0;
  private outputController: TextController = new TextController();
  @State private centerSourceHighlight: boolean = false;
  private pinchBaseFontScaleLevel?: number;
  private pinchOverlayDismissTask?: number;
  private clutchOutputScrollFinalizeTask?: number;
  private sourceCursorTask?: number;
  private clipboardGeneration: number = 0;
  private unsubscribeModel?: () => void;
  private unsubscribeImport?: () => void;
  private shownAlertId?: string;
  private alertController: CustomDialogController = new CustomDialogController({
    builder: TranslationUserAlert({ viewModel: this.viewModel }),
    cancel: () => { this.viewModel.dismissUserAlert(); }
  });

  private model(): TranslationViewModel {
    // V1 State read bridges the intentionally plain Phase-2 .ts model.
    this.revision;
    return this.viewModel;
  }

  private imports(): ImportService {
    this.revision;
    return this.importService;
  }

  aboutToAppear(): void {
    this.appeared = true;
    try {
      const context: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.colorScheme = context.config.colorMode;
      this.applicationContext = context.getApplicationContext();
      this.applicationContext.onSystemConfigurationUpdated(this.configurationUpdated);
      this.previousKeyboardAvoidMode = this.getUIContext().getKeyboardAvoidMode();
      this.updateKeyboardAvoidance();
    } catch (error) { this.reportError(error as BusinessError); }
    window.getLastWindow(this.getUIContext().getHostContext() as common.UIAbilityContext).then((host: window.Window) => {
      if (!this.appeared) return;
      this.hostWindow = host;
      host.on('keyboardHeightChange', this.keyboardHeightChanged);
      this.updateKeyboardPresentation(host.getWindowAvoidArea(window.AvoidAreaType.TYPE_KEYBOARD).bottomRect.height);
    }).catch((error: BusinessError) => { this.reportError(error); });
    this.unsubscribeModel = this.viewModel.observe((model: TranslationViewModel) => {
      this.revision += 1;
      if (model.userAlert && model.userAlert.id !== this.shownAlertId) {
        this.shownAlertId = model.userAlert.id;
        this.alertController.open();
      } else if (!model.userAlert && this.shownAlertId) {
        this.shownAlertId = undefined;
        this.alertController.close();
      }
    });
    this.unsubscribeImport = this.importService.observe((service: ImportService) => { this.revision += 1; });
  }

  aboutToDisappear(): void {
    this.appeared = false;
    this.updateKeyboardPresentation(0);
    try {
      this.applicationContext?.offSystemConfigurationUpdated(this.configurationUpdated);
      if (this.previousKeyboardAvoidMode !== undefined) this.getUIContext().setKeyboardAvoidMode(this.previousKeyboardAvoidMode);
    } catch (error) { this.reportError(error as BusinessError); }
    this.applicationContext = undefined;
    try { this.hostWindow?.off('keyboardHeightChange', this.keyboardHeightChanged); }
    catch (error) { this.reportError(error as BusinessError); }
    this.shareController?.off('dismiss', this.shareDismissed);
    this.shareController = undefined;
    this.hostWindow = undefined;
    this.clipboardGeneration += 1;
    if (this.pinchOverlayDismissTask !== undefined) clearTimeout(this.pinchOverlayDismissTask);
    if (this.clutchOutputScrollFinalizeTask !== undefined) clearTimeout(this.clutchOutputScrollFinalizeTask);
    if (this.sourceCursorTask !== undefined) clearTimeout(this.sourceCursorTask);
    this.sourceController.stopEditing();
    this.unsubscribeModel?.();
    this.unsubscribeImport?.();
    this.unsubscribeModel = undefined;
    this.unsubscribeImport = undefined;
    this.alertController.close();
    this.shownAlertId = undefined;
  }


  private isCompactStackedLayoutActive(): boolean { return !this.wideLayout; }
  private isIPadLandscapeLayoutActive(): boolean { return this.isPadDevice && this.wideLayout; }
  private shouldIgnoreKeyboardSafeAreaBottom(): boolean { return !this.isIPadLandscapeLayoutActive(); }
  private isDarkColorScheme(): boolean { return this.colorScheme === ConfigurationConstant.ColorMode.COLOR_MODE_DARK; }
  private isLightColorScheme(): boolean { return this.colorScheme === ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT; }


  private bodyFontSize(): number {
    return (this.getUIContext().getHostContext() as common.UIAbilityContext).resourceManager.getNumber($r('sys.float.ohos_id_text_size_body1'));
  }
  private editorFontSize(): number { return this.bodyFontSize() * this.model().editorFontScaleMultiplier; }
  private gradientTop(): ResourceColor {
    return this.isDarkColorScheme() ? VisualTokens.darkGradientTop : this.isLightColorScheme() ? VisualTokens.lightGradientTop : $r('sys.color.background_primary');
  }
  private gradientBottom(): ResourceColor {
    return this.isDarkColorScheme() ? VisualTokens.darkGradientBottom : this.isLightColorScheme() ? VisualTokens.lightGradientBottom : $r('sys.color.background_secondary');
  }
  private fieldBackground(): ResourceColor {
    return this.isDarkColorScheme() ? '#3D000000' : this.isLightColorScheme() ? '#4DFFFFFF' : $r('sys.color.comp_background_list_card');
  }
  private fieldBorder(): ResourceColor {
    const color: ColorMetrics = ColorMetrics.resourceColor($r('sys.color.font_primary'));
    return ColorMetrics.rgba(color.red, color.green, color.blue, 0.10).color;
  }
  private toolbarWash(): ResourceColor {
    return this.isDarkColorScheme() ? '#0DFFFFFF' : this.isLightColorScheme() ? '#24FFFFFF' : Color.Transparent;
  }
  private statusColor(): ResourceColor {
    return this.isDarkColorScheme() ? '#EBFFFFFF' : this.isLightColorScheme() ? '#33594D' : $r('sys.color.font_primary');
  }
  private noticeBackground(notice: StatusNotice): ResourceColor {
    const orange: boolean = notice.style === 'orange';
    const color: ColorMetrics = ColorMetrics.resourceColor(orange ? $r('sys.color.ohos_id_color_warning') : $r('sys.color.font_emphasize'));
    const alpha: number = this.isDarkColorScheme() ? 0.58 : this.isLightColorScheme() ? (orange ? 0.32 : 0.28) : color.alpha / 255;
    return ColorMetrics.rgba(color.red, color.green, color.blue, alpha).color;
  }

  private updateKeyboardPresentation(height: number): void {
    this.keyboardHeightPx = Math.max(0, height);
    this.isKeyboardPresented = this.keyboardHeightPx > 0;
    if (!this.isKeyboardPresented || !this.hostWindow) {
      this.keyboardBottomInset = 0;
      return;
    }
    try {
      const content: componentUtils.ComponentInfo = this.getUIContext().getComponentUtils().getRectangleById('screen_translation');
      const windowHeight: number = this.hostWindow.getWindowProperties().windowRect.height;
      const keyboardTop: number = Math.max(0, windowHeight - this.keyboardHeightPx);
      const overlap: number = Math.max(0, Math.min(content.size.height, content.windowOffset.y + content.size.height - keyboardTop));
      this.keyboardBottomInset = this.getUIContext().px2vp(overlap);
    } catch (error) {
      this.keyboardBottomInset = this.getUIContext().px2vp(this.keyboardHeightPx);
      this.reportError(error as BusinessError);
    }
  }

  private updateKeyboardAvoidance(): void {
    const mode: KeyboardAvoidMode = this.shouldIgnoreKeyboardSafeAreaBottom() ? KeyboardAvoidMode.NONE : KeyboardAvoidMode.RESIZE;
    if (this.getUIContext().getKeyboardAvoidMode() !== mode) this.getUIContext().setKeyboardAvoidMode(mode);
  }

  private reportError(error: BusinessError): void {
    this.viewModel.errorMessage = describeError(error);
    this.viewModel.notifyStateChanged();
  }

  private async importFile(): Promise<void> {
    this.dismissKeyboard();
    try { await this.importService.presentFileImporter(); }
    catch (error) { this.showImportError(error as BusinessError); }
  }

  private async importPhoto(): Promise<void> {
    this.dismissKeyboard();
    try { await this.importService.presentPhotoPicker(); }
    catch (error) { this.showImportError(error as BusinessError); }
  }

  private showImportError(error: BusinessError): void {
    // Phase2 owns import completion/toasts; cancellation is an intentional logical completion.
    if ((error as Error).message !== 'Import cancelled.') {
      this.importService.showImportToast(describeError(error));
    }
  }

  private async pasteInputFromClipboard(replaceSource: boolean = true): Promise<void> {
    const generation: number = ++this.clipboardGeneration;
    try {
      const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
      if (!await board.hasData()) return;
      const data: pasteboard.PasteData = await board.getData();
      if (generation !== this.clipboardGeneration) return;
      if (data.hasType(pasteboard.MIMETYPE_PIXELMAP)) {
        const pixelMap: image.PixelMap = data.getPrimaryPixelMap();
        const packer: image.ImagePacker = image.createImagePacker();
        let bytes: ArrayBuffer;
        try { bytes = await packer.packToData(pixelMap, { format: 'image/png', quality: 100 }); }
        finally { try { await packer.release(); } finally { await pixelMap.release(); } }
        if (generation !== this.clipboardGeneration) return;
        await this.importService.handlePastedImageOnIOS(bytes);
      } else {
        const text: string = data.getPrimaryText() ?? '';
        if (text.length === 0) return;
        if (replaceSource) this.viewModel.handleSourceTextPasted(text);
        else {
          const selection: RichEditorSelection = this.sourceController.getSelection();
          const start: number = Math.max(0, selection.selection[0]);
          const end: number = Math.max(start, selection.selection[1]);
          this.sourceController.deleteSpans({ start: start, end: end });
          this.sourceController.addTextSpan(text, { offset: start });
          this.sourceController.setCaretOffset(start + text.length);
        }
      }
    } catch (error) { if (generation === this.clipboardGeneration) this.showImportError(error as BusinessError); }
  }

  private clearSourceAndResetRuntimeState(): void {
    this.clipboardGeneration += 1;
    this.importService.cancelImport();
    this.viewModel.clearSourceTextAndResetLanguageState();
    this.centerSourceHighlight = false;
  }

  private stopTranslation(): void {
    this.clipboardGeneration += 1;
    this.importService.cancelImport();
    this.viewModel.stopTranslation();
  }

  private dismissKeyboard(): void {
    this.sourceController.stopEditing();
    this.getUIContext().getFocusController().clearFocus();
    this.sourceFocused = false;
    this.viewModel.refreshLanguageMenuSourceLanguage();
  }

  private async performTranslation(): Promise<void> {
    this.dismissKeyboard();
    try { await this.viewModel.translate(); }
    catch (error) { this.reportError(error as BusinessError); }
  }

  private async switchEngine(): Promise<void> {
    try {
      if (this.viewModel.usesAppleIntelligenceTranslation) this.viewModel.switchToStandardTranslation();
      else await this.viewModel.switchToAppleIntelligenceTranslation();
    } catch (error) { this.reportError(error as BusinessError); }
  }

  private async copyOutputToClipboard(): Promise<void> {
    try {
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(
        pasteboard.MIMETYPE_TEXT_PLAIN, this.viewModel.translatedText));
    } catch (error) { this.reportError(error as BusinessError); }
  }

  private async shareOutput(): Promise<void> {
    let controller: systemShare.ShareController | undefined;
    this.shareController?.off('dismiss', this.shareDismissed);
    try {
      const data: systemShare.SharedData = new systemShare.SharedData({
        utd: uniformTypeDescriptor.UniformDataType.PLAIN_TEXT, content: this.viewModel.translatedText
      });
      controller = new systemShare.ShareController(data);
      this.shareController = controller;
      controller.on('dismiss', this.shareDismissed);
      await controller.show(this.getUIContext().getHostContext() as common.UIAbilityContext,
        { previewMode: systemShare.SharePreviewMode.DETAIL });
    } catch (error) {
      controller?.off('dismiss', this.shareDismissed);
      this.shareController = undefined;
      try {
        await pasteboard.getSystemPasteboard().setData(pasteboard.createData(
          pasteboard.MIMETYPE_TEXT_PLAIN, this.viewModel.translatedText));
        this.importService.showImportToast('Share unavailable. Output copied to clipboard.');
      } catch (copyError) { this.reportError(copyError as BusinessError); }
    }
  }

  private updatePinch(scale: number, host: string): void {
    if (this.pinchBaseFontScaleLevel === undefined) {
      this.pinchBaseFontScaleLevel = this.viewModel.editorFontScaleLevel;
      if (this.pinchOverlayDismissTask !== undefined) clearTimeout(this.pinchOverlayDismissTask);
    }
    const step: number = Math.round(Math.log(Math.max(0.01, scale)) / Math.log(1.15));
    const level: number = Math.max(0, Math.min(4, this.pinchBaseFontScaleLevel + step));
    if (level !== this.viewModel.editorFontScaleLevel) this.viewModel.editorFontScaleLevel = level;
    this.pinchOverlayHost = host;
    const isJapanese: boolean = i18n.System.getPreferredLanguageList()[0]?.startsWith('ja') === true;
    this.pinchOverlayText = `${isJapanese ? '文字サイズ' : 'Text Size'} ${this.viewModel.editorFontScaleLabel}`;
  }

  private handlePinchEnded(): void {
    this.pinchBaseFontScaleLevel = undefined;
    if (this.pinchOverlayDismissTask !== undefined) clearTimeout(this.pinchOverlayDismissTask);
    this.pinchOverlayDismissTask = setTimeout(() => {
      this.pinchOverlayText = undefined; this.pinchOverlayHost = undefined;
      this.pinchOverlayDismissTask = undefined;
    }, 600);
  }

  private sourceCursorChanged(location: number): void {
    if (this.sourceCursorTask !== undefined) clearTimeout(this.sourceCursorTask);
    this.sourceCursorTask = setTimeout(() => {
      this.sourceCursorTask = undefined;
      this.centerSourceHighlight = false;
      this.viewModel.handleSourceCursorLocationChange(location);
      const index: number | undefined = this.viewModel.clutchSelectedSegmentIndex;
      if (index !== undefined) this.scrollOutputToClutchTarget(index);
    }, 0);
  }

  private outputSegmentTapped(index: number): void {
    if (!this.viewModel.clutchModeEnabled) return;
    this.centerSourceHighlight = true;
    this.viewModel.handleOutputSegmentTap(index);
  }

  private scrollOutputToClutchTarget(index: number): void {
    this.alignOutputSegment(index);
    if (this.clutchOutputScrollFinalizeTask !== undefined) clearTimeout(this.clutchOutputScrollFinalizeTask);
    this.clutchOutputScrollFinalizeTask = setTimeout(() => {
      if (this.viewModel.clutchSelectedSegmentIndex === index) this.alignOutputSegment(index);
      this.clutchOutputScrollFinalizeTask = undefined;
    }, 220);
  }

  private alignOutputSegment(index: number): void {
    let offset: number = 0;
    for (let position: number = 0; position < this.viewModel.segmentOutputs.length; position += 1) {
      const segment: SegmentOutput = this.viewModel.segmentOutputs[position];
      if (segment.segmentIndex === index) {
        const boxes: graphicsText.TextBox[] = this.outputController.getLayoutManager().getRectsForRange(
          { start: offset, end: offset + segment.translatedText.length }, graphicsText.RectWidthStyle.TIGHT, graphicsText.RectHeightStyle.TIGHT);
        if (boxes.length > 0) {
          const top: number = this.getUIContext().px2vp(boxes[0].rect.top) + VisualTokens.outputTop;
          const bottom: number = this.getUIContext().px2vp(boxes[boxes.length - 1].rect.bottom) + VisualTokens.outputTop;
          const y: number = !this.isCompactStackedLayoutActive() ? (top + bottom - this.outputViewportHeight) / 2 : top;
          this.outputScroller.scrollTo({ xOffset: 0, yOffset: Math.max(0, y), animation: false });
        }
        return;
      }
      offset += segment.translatedText.length + (this.viewModel.segmentJoinersAfter[position]?.length ?? 0);
    }
  }

  private outputSegmentBackground(segment: SegmentOutput): ResourceColor {
    if (this.model().clutchModeEnabled && this.model().clutchSelectedSegmentIndex === segment.segmentIndex) return VisualTokens.selectedHighlight;
    if (segment.isUnsafeFallback && segment.isUnsafeRecoveredByTranslationFramework) return this.segmentTint($r('sys.color.font_emphasize'), 0.34, 0.18);
    if (segment.isUnsafeFallback) return this.segmentTint($r('sys.color.ohos_id_color_warning'), 0.65, 0.38);
    return Color.Transparent;
  }

  private segmentTint(resource: ResourceColor, darkAlpha: number, lightAlpha: number): ResourceColor {
    const color: ColorMetrics = ColorMetrics.resourceColor(resource);
    return ColorMetrics.rgba(color.red, color.green, color.blue,
      this.isDarkColorScheme() ? darkAlpha : this.isLightColorScheme() ? lightAlpha : color.alpha / 255).color;
  }

  private indexesText(): string {
    const timing: string = this.model().traces.find((trace) => trace.step.includes('processing-time'))?.summary ?? '(n/a)';
    return `Engine: ${this.model().engineName || '(none)'}\nMode: ${experimentModeDisplayName(this.model().experimentMode)}\nDetected language: ${
      this.model().detectedLanguageCode || '(none)'}\nLanguage support index: ${this.model().aiLanguageSupported ? 'supported' : 'unsupported'}\nProcessing time index: ${timing}\nProtected tokens: ${this.model().protectedTokens.length}\nGlossary matches: ${
      this.model().glossaryMatches.length}\nAmbiguity hints: ${this.model().ambiguityHints.length}\nTrace steps: ${this.model().traces.length}`;
  }

  private targetLabel(): string {
    const selected: TargetLanguageOption | undefined = this.model().targetLanguageOptions.find(
      (option: TargetLanguageOption) => option.code === this.model().targetLanguage);
    return selected ? this.model().targetLanguageMenuLabel(selected) : 'Target Language';
  }

  private languageLabel(option: TargetLanguageOption): string {
    return `${option.code === this.model().targetLanguage ? '✓ ' : ''}${this.model().targetLanguageMenuLabel(option)}`;
  }

  @Builder
  private languageRows(options: TargetLanguageOption[]) {
    ForEach(options, (option: TargetLanguageOption) => {
      // iOS shows '<label> ⬇︎' as a text glyph. Here the '⬇︎' character falls back to a blue emoji tile on most
      // scripts, so the mark is a symbol glyph after a space, in the label colour.
      Button() {
        Row({ space: 6 }) {
          Text(this.languageLabel(option)).fontColor($r('sys.color.font_primary')).fontSize($r('sys.float.ohos_id_text_size_body1'))
          if (this.model().tfMenuDownloadMark(option.code) !== undefined) {
            SymbolGlyph($r('sys.symbol.arrow_down')).fontSize($r('sys.float.ohos_id_text_size_body1')).fontWeight(FontWeight.Medium)
              .fontColor([$r('sys.color.font_primary')]).accessibilityLevel('no')
          }
        }
      }.id('translation_target_language_itemroot').accessibilityText(this.languageLabel(option))
        .backgroundColor(Color.Transparent).fontColor($r('sys.color.font_primary')).fontSize($r('sys.float.ohos_id_text_size_body1'))
        .constraintSize({ minHeight: $r('sys.float.ohos_id_menu_title_height') }).width('100%').borderRadius(0)
        .opacity(this.model().isTargetLanguageSelectionDisabled(option.code) ? 0.3 : 1)
        .enabled(!this.model().isTargetLanguageSelectionDisabled(option.code))
        .onClick(() => { this.viewModel.selectTargetLanguageFromMenu(option.code); })
      if (this.model().targetLanguageSelectionHelpText(option.code)) { Text(this.model().targetLanguageSelectionHelpText(option.code) ?? '').fontSize($r('sys.float.ohos_id_text_size_body3')).fontColor($r('sys.color.font_secondary')) }
    }, (option: TargetLanguageOption) => option.code)
  }

  @Builder
  private languageMenu() {
    Column() {
      if (this.model().isAppleIntelligenceAvailable) {
        Button(this.model().usesAppleIntelligenceTranslation ? 'Switch to Standard Translation' : 'Switch to AI Translation')
          .id('translation_switch_engine').backgroundColor(Color.Transparent).fontColor($r('sys.color.font_primary')).fontSize($r('sys.float.ohos_id_text_size_body1')).constraintSize({ minHeight: $r('sys.float.ohos_id_menu_title_height') }).onClick(async () => { await this.switchEngine(); })
      } else {
        Button('AI translation unavailable on this device').id('translation_ai_unavailable').backgroundColor(Color.Transparent).fontColor($r('sys.color.font_secondary')).constraintSize({ minHeight: $r('sys.float.ohos_id_menu_title_height') }).enabled(false)
      }
      Divider()
      this.languageRows(this.model().recentTargetLanguageOptions())
      if (this.model().recentTargetLanguageOptions().length > 0 &&
        this.model().remainingTargetLanguageOptionsExcludingRecent().length > 0) { Divider() }
      this.languageRows(this.model().remainingTargetLanguageOptionsExcludingRecent())
      // iOS puts this switch in the system Settings app (Settings.bundle); HarmonyOS apps cannot add
      // items there, so it lives at the end of this menu. Same key (developerModeEnabled), off by default.
      Divider()
      Row({ space: 12 }) {
        Text('Developer Mode').fontSize($r('sys.float.ohos_id_text_size_body1')).fontColor($r('sys.color.font_primary'))
        Toggle({ type: ToggleType.Switch, isOn: this.model().developerModeEnabled })
          .id('translation_developer_mode')
          .onChange((isOn: boolean) => { this.viewModel.developerModeEnabled = isOn; })
      }
      .constraintSize({ minHeight: $r('sys.float.ohos_id_menu_title_height') })
    }
  }

  @Builder
  private sourceButtons() {
    Row({ space: VisualTokens.sourceDockGap }) {
      Button() {
        InteractiveSymbolButtonStyle({ label: 'Files', isEnabled: this.canImportOrPaste() })
      }.type(ButtonType.Normal).backgroundColor(Color.Transparent).padding(0).accessibilityText('Files').id('translation_import_files').enabled(this.canImportOrPaste()).onClick(async () => { await this.importFile(); })
      Button() {
        InteractiveSymbolButtonStyle({ label: 'Album', isEnabled: this.canImportOrPaste() })
      }.type(ButtonType.Normal).backgroundColor(Color.Transparent).padding(0).accessibilityText('Album').id('translation_import_photos').enabled(this.canImportOrPaste()).onClick(async () => { await this.importPhoto(); })
      // HarmonyOS only lets an app read the clipboard through the PasteButton security component (a plain
      // pasteboard.getData() is refused), so the iOS Paste glyph becomes the system paste icon here.
      PasteButton({ icon: PasteIconStyle.LINES, buttonType: ButtonType.Normal })
        .iconSize(this.canImportOrPaste() ? 22 : 17)
        .iconColor(this.canImportOrPaste() ? $r('sys.color.font_secondary') : $r('sys.color.font_tertiary'))
        // Security components draw their background opaque (a transparent one turns black): match the toolbar.
        .backgroundColor($r('sys.color.comp_background_primary'))
        .width(60).height(34).padding(0)
        .id('translation_paste')
        .onClick(async (event: ClickEvent, result: PasteButtonOnClickResult) => {
          if (this.canImportOrPaste() && result === PasteButtonOnClickResult.SUCCESS) { await this.pasteInputFromClipboard(); }
        })
      Button() {
        InteractiveSymbolButtonStyle({ label: 'Clear', isEnabled: this.model().inputText.trim().length > 0 })
      }.type(ButtonType.Normal).backgroundColor(Color.Transparent).padding(0).accessibilityText('Clear').id('translation_clear_source').enabled(this.model().inputText.trim().length > 0).onClick(() => { this.clearSourceAndResetRuntimeState(); })
    }.id('translation_source_dock').width(VisualTokens.dockWidth).height(VisualTokens.dockHeight)
      .padding({ start: LengthMetrics.vp(12), end: LengthMetrics.vp(12), top: LengthMetrics.vp(6), bottom: LengthMetrics.vp(6)})
      .borderRadius(this.isCompactStackedLayoutActive() ? { topStart: LengthMetrics.vp(16), topEnd: LengthMetrics.vp(16) } : { bottomStart: LengthMetrics.vp(16), bottomEnd: LengthMetrics.vp(16) })
      .backgroundColor(this.toolbarWash()).backgroundBlurStyle(BlurStyle.Thin)
  }

  private canImportOrPaste(): boolean {
    return !this.imports().isImportLoading && !this.model().isTranslating && this.model().inputText.trim().length === 0;
  }

  @Builder
  private sourceCardBody() {
    Stack() {
      IOSClutchSourceTextEditor({
          text: this.model().inputText,
          highlightedRange: this.model().sourceHighlightRange,
          controller: this.sourceController,
          fontScaleMultiplier: this.model().editorFontScaleMultiplier,
          fontPointSize: this.bodyFontSize(),
          additionalTopInset: this.isCompactStackedLayoutActive() ? 0 : 46,
          additionalBottomInset: this.isCompactStackedLayoutActive() ? 52 : 0,
          centerOnHighlightIfNeeded: this.centerSourceHighlight,
          topAlignOnHighlightScroll: this.isCompactStackedLayoutActive(),
          onCursorLocationChanged: (location: number) => { this.sourceCursorChanged(location); },
          onPaste: async (event: PasteEvent) => { event.preventDefault?.(); await this.pasteInputFromClipboard(false); },
          onTextChanged: (text: string) => { this.clipboardGeneration += 1; this.viewModel.inputText = text; },
          onEditingStarted: () => { this.sourceFocused = true; },
          onEditingEnded: () => { this.sourceFocused = false; this.viewModel.refreshLanguageMenuSourceLanguage(); }
      }).width('100%').height('100%').padding(VisualTokens.editorInner).gesture(PinchGesture({ fingers: 2 }).onActionUpdate((event: GestureEvent) => { this.updatePinch(event.scale, 'source'); }).onActionEnd(() => { this.handlePinchEnded(); }).onActionCancel(() => { this.handlePinchEnded(); }))
      Column() {
        if (!this.isCompactStackedLayoutActive()) { this.sourceButtons(); Blank() }
        else { Blank(); this.sourceButtons() }
      }.height('100%').hitTestBehavior(HitTestMode.Transparent)
      if (this.imports().isImportLoading) {
        Column() { LoadingProgress().width(20).height(20); Text('Loading...').fontSize(14).fontWeight(FontWeight.Medium).fontColor(Color.White) }.padding({ start: LengthMetrics.vp(14), end: LengthMetrics.vp(14), top: LengthMetrics.vp(10), bottom: LengthMetrics.vp(10)}).backgroundColor('#D1000000').borderRadius(50).hitTestBehavior(HitTestMode.Transparent)
      } else if (this.imports().importToastMessage &&
        this.imports().importToastPlacement === ImportToastPlacement.SOURCE_FIELD_CENTER) {
        Text(this.imports().importToastMessage ?? '').fontSize(14).fontWeight(FontWeight.Medium).fontColor(Color.White).padding({ start: LengthMetrics.vp(14), end: LengthMetrics.vp(14), top: LengthMetrics.vp(10), bottom: LengthMetrics.vp(10)}).backgroundColor('#D1000000').borderRadius(50).hitTestBehavior(HitTestMode.Transparent)
      }
      if (this.pinchOverlayText && this.pinchOverlayHost === 'source') {
        this.pinchOverlayBadge()
      }
    }
  }

  @Builder
  private sourceCard() {
    RoundedCornerShape({
      corners: this.isIPadLandscapeLayoutActive() ? [RoundedCorner.TOP_START, RoundedCorner.BOTTOM_START] :
        [RoundedCorner.TOP_START, RoundedCorner.TOP_END],
      radius: VisualTokens.wrapperRadius,
      content: () => { this.sourceCardBody(); }
    })
    .layoutWeight(this.isCompactStackedLayoutActive() ? 0 : 1).width('100%')
      .height(this.isCompactStackedLayoutActive() ? 'calc(50% - 11vp)' : '100%').constraintSize({ minHeight: 140 }).backgroundColor(this.fieldBackground())
      .borderRadius({ topStart: LengthMetrics.vp(18), topEnd: LengthMetrics.vp(this.isIPadLandscapeLayoutActive() ? 0 : 18), bottomStart: LengthMetrics.vp(this.isIPadLandscapeLayoutActive() ? 18 : 0) })
      .border({ width: 1, color: this.fieldBorder() })
  }

  @Builder
  private outputSegments() {
    if (this.model().translatedText.length === 0) {
      Column().width('100%')
    } else if (this.model().segmentOutputs.length === 0) {
      Text(this.model().translatedText).id('translation_output_text').copyOption(CopyOptions.InApp).fontSize(this.editorFontSize()).fontColor($r('sys.color.font_primary')).textAlign(editorTextAlign(this.model().translatedText)).width('100%')
    } else {
      Column() {
        Text(undefined, { controller: this.outputController }) {
          ForEach(this.model().segmentOutputs, (segment: SegmentOutput, index: number) => {
            if (segment.isUnsafeFallback && segment.isUnsafeRecoveredByTranslationFramework) {
              Span(segment.translatedText + (this.model().segmentJoinersAfter[index] ?? ''))
                .textBackgroundStyle({ color: this.outputSegmentBackground(segment) })
                .onClick(() => { this.outputSegmentTapped(segment.segmentIndex); })
            } else if (segment.isUnsafeFallback) {
              Span(segment.translatedText + (this.model().segmentJoinersAfter[index] ?? ''))
                .textBackgroundStyle({ color: this.outputSegmentBackground(segment) })
                .onClick(() => { this.outputSegmentTapped(segment.segmentIndex); })
            } else {
              Span(segment.translatedText + (this.model().segmentJoinersAfter[index] ?? ''))
                .textBackgroundStyle({ color: this.outputSegmentBackground(segment) })
                .onClick(() => { this.outputSegmentTapped(segment.segmentIndex); })
            }
          }, (segment: SegmentOutput) => segment.segmentIndex.toString())
        }.id('translation_segment_link').copyOption(CopyOptions.InApp).fontSize(this.editorFontSize()).fontColor($r('sys.color.font_primary')).textAlign(editorTextAlign(this.model().translatedText)).width('100%')
      }
      .id('translation_output_text')
    }
  }

  @Builder
  private outputControls() {
      Row({ space: VisualTokens.toolbarGap }) {
        if (this.model().targetLanguageOptions.length > 0) {
          Button() {
            Row({ space: 4 }) {
              Text(this.targetLabel()).fontSize($r('sys.float.ohos_id_text_size_body1')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).flexShrink(1)
              SymbolGlyph($r('sys.symbol.chevron_down')).fontSize(11).fontWeight(FontWeight.Medium).fontColor([$r('sys.color.font_primary')]).accessibilityLevel('no')
            }.width('100%').justifyContent(FlexAlign.Center)
          }.type(ButtonType.Normal).backgroundColor(Color.Transparent).fontColor($r('sys.color.font_primary')).padding(0).id('translation_language_menu')
            .layoutWeight(1)
            .bindMenu(this.languageMenu, { mask: true }) // the target menu opens over a dimmed background
            .onClick(() => { this.viewModel.refreshLanguageMenuSourceLanguage(); })
        } else { Text('No target') }
        Button() { SymbolGlyph($r('sys.symbol.translate')).fontSize(20).fontWeight(FontWeight.Medium).fontColor([Color.White]).accessibilityLevel('no') }
          .width(60).height(34).padding(0).backgroundColor($r('sys.color.font_emphasize')).borderRadius(50).accessibilityText('Translate')
          .opacity(this.model().isTranslating || this.model().targetLanguageOptions.length === 0 ? 0.5 : 1).id('translation_translate')
          .enabled(!this.model().isTranslating && this.model().targetLanguageOptions.length > 0).onClick(async () => { await this.performTranslation(); })
        Button() { Image($r('app.media.ic_square_and_arrow_up')).width(20).height(20).objectFit(ImageFit.Contain).fillColor($r('sys.color.font_secondary')).accessibilityLevel('no') }
          .width(42).height(36).padding(0).backgroundColor(this.toolbarWash()).backgroundBlurStyle(BlurStyle.Thin).borderRadius(50).accessibilityText('Share')
          .opacity(this.model().translatedText.length > 0 ? 1 : 0.3).id('translation_share_output').enabled(this.model().translatedText.length > 0).onClick(async () => { await this.shareOutput(); })
      }.id('translation_output_bar').width(VisualTokens.dockWidth).height(VisualTokens.dockHeight)
        .padding({ start: LengthMetrics.vp(12), end: LengthMetrics.vp(12), top: LengthMetrics.vp(7), bottom: LengthMetrics.vp(7)})
        .borderRadius({ bottomStart: LengthMetrics.vp(16), bottomEnd: LengthMetrics.vp(16) })
        .backgroundColor(this.toolbarWash()).backgroundBlurStyle(BlurStyle.Thin)
        .linearGradient({ direction: GradientDirection.Bottom, colors: [[this.isDarkColorScheme() ? '#29FFFFFF' : this.isLightColorScheme() ? '#3DFFFFFF' : Color.Transparent, 0], [this.isDarkColorScheme() || this.isLightColorScheme() ? '#03FFFFFF' : Color.Transparent, 1]] })
        .shadow({ radius: 6, color: this.isDarkColorScheme() ? '#33000000' : '#1A000000', offsetY: 2 })
        .opacity(this.model().targetLanguageOptions.length === 0 ? 0.55 : 1)
  }

  // At the top of the pinched pane, as iOS .overlay(alignment: .top) (a Stack child's align() does not move it).
  // In the output pane it starts where the text starts, below the language/Translate bar it would otherwise cover.
  @Builder
  private pinchOverlayBadge(top: number = 8) {
    Column() {
      Text(this.pinchOverlayText ?? '').fontSize(13).fontWeight(FontWeight.Medium).fontColor(Color.White).padding({ start: LengthMetrics.vp(12), end: LengthMetrics.vp(12), top: LengthMetrics.vp(8), bottom: LengthMetrics.vp(8)}).backgroundColor('#C7000000').borderRadius(50)
    }.width('100%').height('100%').justifyContent(FlexAlign.Start).padding({ top: top }).hitTestBehavior(HitTestMode.Transparent)
  }

  @Builder
  private outputCardBody() {
    Column() {
      Stack() {
        Scroll(this.outputScroller) {
          Column() { this.outputSegments() }.width('100%').padding({ start: LengthMetrics.vp(12), end: LengthMetrics.vp(12), top: LengthMetrics.vp(VisualTokens.outputTop), bottom: LengthMetrics.vp(12)})
        }
          .id('translation_output_scroll').width('100%').height('100%').align(Alignment.TopStart).scrollBar(BarState.Auto)
          .onAreaChange((oldArea: Area, area: Area) => { this.outputViewportHeight = Number(area.height); })
          .gesture(PinchGesture({ fingers: 2 }).onActionUpdate((event: GestureEvent) => { this.updatePinch(event.scale, 'output'); }).onActionEnd(() => { this.handlePinchEnded(); }).onActionCancel(() => { this.handlePinchEnded(); }))
        Column() {
          this.outputControls()
          Blank()
          Row() {
            Blank()
            Button() {
              InteractiveSymbolButtonStyle({ label: 'Copy output', isEnabled: this.model().translatedText.length > 0 })
            }.width(34).height(34).padding(0).backgroundColor(this.toolbarWash()).backgroundBlurStyle(BlurStyle.Thin).borderRadius(50).border({ width: 1, color: this.isDarkColorScheme() ? '#52FFFFFF' : '#B3FFFFFF' }).accessibilityText('Copy output').id('translation_copy_output').enabled(this.model().translatedText.length > 0).onClick(async () => { await this.copyOutputToClipboard(); })
          }.width('100%').padding({ end: LengthMetrics.vp(10) })
        }.height('100%').width('100%').padding({ bottom: 10 }).alignItems(HorizontalAlign.Center).hitTestBehavior(HitTestMode.Transparent)
        if (this.pinchOverlayText && this.pinchOverlayHost === 'output') {
          this.pinchOverlayBadge(VisualTokens.outputTop)
        }
      }.layoutWeight(1)
      Row() {
        if (this.model().errorMessage !== undefined) { Text(this.model().errorMessage ?? '').fontSize($r('sys.float.ohos_id_text_size_body3')).fontColor($r('sys.color.alert')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).id('translation_status') }
        else {
          if (this.model().languagePackDownloadText !== undefined && !this.model().isTranslating) {
            Row({ space: 6 }) {
              LoadingProgress().width(18).height(18).color($r('sys.color.font_secondary'))
              Text(this.model().languagePackDownloadText ?? '').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('sys.color.font_secondary')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            }.id('translation_pack_download').layoutWeight(1)
          } else {
            Text(this.model().statusText).fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.statusColor()).maxLines(1).id('translation_status')
          }
          ForEach(this.model().statusNotices, (notice: StatusNotice) => {
            Row({ space: 6 }) { Text(notice.markerText).fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('sys.color.font_primary')).padding({ start: LengthMetrics.vp(8), end: LengthMetrics.vp(8), top: LengthMetrics.vp(4), bottom: LengthMetrics.vp(4)}).backgroundColor(this.noticeBackground(notice)).borderRadius(50); Text(notice.text).fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('sys.color.font_secondary')).maxLines(1) }
          }, (notice: StatusNotice) => notice.id)
          Blank()
          if (this.model().isTranslating) { Button() { Row({ space: 6 }) { Image($r('app.media.ic_stop_fill')).width(12).height(12).objectFit(ImageFit.Contain).fillColor($r('sys.color.font_emphasize')).accessibilityLevel('no'); Text('Stop') } }.accessibilityText('Stop').fontSize($r('sys.float.ohos_id_text_size_body2')).backgroundColor(this.toolbarWash()).fontColor($r('sys.color.font_emphasize')).id('translation_stop').onClick(() => { this.stopTranslation(); }) }
        }
      }.constraintSize({ minHeight: VisualTokens.statusHeight }).width('100%').padding({ start: LengthMetrics.vp(this.editorFontSize()), end: LengthMetrics.vp(this.editorFontSize()) }).backgroundColor(this.fieldBackground()).border({ width: { top: 1 }, color: this.fieldBorder() })
    }.height('100%').width('100%')
  }

  @Builder
  private outputColumn() {
    RoundedCornerShape({
      corners: this.isIPadLandscapeLayoutActive() ? [RoundedCorner.TOP_END, RoundedCorner.BOTTOM_END] :
        [RoundedCorner.BOTTOM_START, RoundedCorner.BOTTOM_END],
      radius: VisualTokens.wrapperRadius,
      clipContent: true,
      content: () => { this.outputCardBody(); }
    }).layoutWeight(1).width('100%').height('100%').backgroundColor(this.fieldBackground())
      .borderRadius({ bottomEnd: LengthMetrics.vp(18), topEnd: LengthMetrics.vp(this.isIPadLandscapeLayoutActive() ? 18 : 0), bottomStart: LengthMetrics.vp(this.isIPadLandscapeLayoutActive() ? 0 : 18) }).border({ width: 1, color: this.fieldBorder() })
  }

  @Builder
  private experimentMenu() {
    // A native menu with a checkmark on the current mode, as the iOS .menu Picker.
    Menu() {
      ForEach(TRANSLATION_EXPERIMENT_MODES, (mode: TranslationExperimentMode) => {
        MenuItem({ content: experimentModeDisplayName(mode) }).selected(this.model().experimentMode === mode).selectIcon(true)
          .id('translation_experiment_itemroot').onClick(() => { this.viewModel.experimentMode = mode; })
      }, (mode: TranslationExperimentMode) => mode)
    }
  }

  @Builder
  private developerPanels() {
    Column() {
      Column() {
        // As iOS: a 'Process Mode' group holding the 'Experiment' menu picker (label left, value right).
        Text($r('app.string.ui_dev_process_mode')).fontSize($r('sys.float.ohos_id_text_size_body2')).fontWeight(FontWeight.Medium).fontColor($r('sys.color.font_secondary'))
        Row() {
          Text($r('app.string.ui_dev_experiment')).fontSize($r('sys.float.ohos_id_text_size_body1')).fontColor($r('sys.color.font_primary'))
          Blank()
          Button(experimentModeDisplayName(this.model().experimentMode)).id('translation_experiment').backgroundColor(Color.Transparent).fontColor($r('sys.color.font_emphasize')).fontSize($r('sys.float.ohos_id_text_size_body1')).bindMenu(this.experimentMenu)
        }.width('100%')
      }.width('100%').alignItems(HorizontalAlign.Start).padding(8).backgroundColor($r('sys.color.comp_background_list_card')).borderRadius($r('sys.float.ohos_id_corner_radius_card'))
      Column() {
        Text($r('app.string.ui_dev_glossary')).fontSize($r('sys.float.ohos_id_text_size_body2')).fontWeight(FontWeight.Medium).fontColor($r('sys.color.font_secondary'))
        TextArea({ text: this.model().glossaryText }).id('translation_glossary').constraintSize({ minHeight: 80 }).fontSize($r('sys.float.ohos_id_text_size_body1')).fontColor($r('sys.color.font_primary')).backgroundColor(Color.Transparent).onChange((text: string) => { this.viewModel.glossaryText = text; })
      }.width('100%').alignItems(HorizontalAlign.Start).padding(8).backgroundColor($r('sys.color.comp_background_list_card')).borderRadius($r('sys.float.ohos_id_corner_radius_card'))
      Column() {
        Text($r('app.string.ui_dev_indexes')).fontSize($r('sys.float.ohos_id_text_size_body2')).fontWeight(FontWeight.Medium).fontColor($r('sys.color.font_secondary'))
        Scroll() {
          Text(this.indexesText())
            .id('translation_indexes').copyOption(CopyOptions.InApp).width('100%').textAlign(TextAlign.Start).fontSize($r('sys.float.ohos_id_text_size_body1')).fontColor($r('sys.color.font_primary'))
        }.constraintSize({ minHeight: 140 }).width('100%').align(Alignment.TopStart)
      }.width('100%').alignItems(HorizontalAlign.Start).padding(8).backgroundColor($r('sys.color.comp_background_list_card')).borderRadius($r('sys.float.ohos_id_corner_radius_card'))
      Column() {
        Row() {
          Text($r('app.string.ui_dev_console')).fontSize($r('sys.float.ohos_id_text_size_body2')).fontWeight(FontWeight.Medium).fontColor($r('sys.color.font_secondary'))
          Blank()
          Button($r('app.string.ui_action_clear')).fontSize($r('sys.float.ohos_id_text_size_body2')).backgroundColor(this.toolbarWash()).fontColor($r('sys.color.font_emphasize')).id('translation_clear_console').enabled(this.model().developerLogs.length > 0).onClick(() => { this.viewModel.clearDeveloperLogs(); })
        }.width('100%')
        Scroll() { Text(this.model().developerLogsText).id('translation_console').copyOption(CopyOptions.InApp).fontSize(12).fontFamily('monospace').fontColor($r('sys.color.font_primary')).width('100%').textAlign(TextAlign.Start) }.constraintSize({ minHeight: 120, maxHeight: 220 }).width('100%').padding(8).backgroundColor(this.isDarkColorScheme() ? '#40000000' : this.isLightColorScheme() ? '#73FFFFFF' : $r('sys.color.comp_background_list_card')).borderRadius(12)
      }.width('100%').alignItems(HorizontalAlign.Start).padding(8).backgroundColor($r('sys.color.comp_background_list_card')).borderRadius($r('sys.float.ohos_id_corner_radius_card'))
    }.width('100%').margin({ top: 14 }).alignItems(HorizontalAlign.Start)
  }

  @Builder
  private editors() {
    if (this.isCompactStackedLayoutActive()) { Column() { this.sourceCard(); this.outputColumn() }.layoutWeight(1).width('100%').height('100%').margin({ bottom: 6 }) }
    else { Row() { this.sourceCard(); this.outputColumn() }.layoutWeight(1).width('100%') }
  }

  build() {
    Stack() {
      if (this.model().developerModeEnabled) {
        // As on iOS, the editors keep their full-screen height and the developer panels follow below them.
        Scroll() {
          Column() {
            Column() { this.editors() }.width('100%').height(Math.max(0, this.pageHeight - VisualTokens.outerTop - VisualTokens.outerBottom))
            this.developerPanels()
          }.id('translation_pinch').width('100%').padding({ start: LengthMetrics.vp(VisualTokens.outerHorizontal), end: LengthMetrics.vp(VisualTokens.outerHorizontal), top: LengthMetrics.vp(VisualTokens.outerTop), bottom: LengthMetrics.vp(VisualTokens.outerBottom)})
        }.id('translation_developer_scroll').width('100%').height('100%').align(Alignment.Top).scrollBar(BarState.Auto)
      } else {
        Column() {
          this.editors()
        }.id('translation_pinch').width('100%').height('100%').padding({ start: LengthMetrics.vp(VisualTokens.outerHorizontal), end: LengthMetrics.vp(VisualTokens.outerHorizontal), top: LengthMetrics.vp(VisualTokens.outerTop), bottom: LengthMetrics.vp(VisualTokens.outerBottom)})
      }
      if (this.imports().importToastMessage && !this.imports().isImportLoading &&
        this.imports().importToastPlacement === ImportToastPlacement.BOTTOM) {
        // As iOS: VStack { Spacer(); full-width capsule } with 16 pt sides and 28 pt bottom padding
        // (a Stack child's align() would leave it centered).
        Column() {
          Blank()
          Text(this.imports().importToastMessage ?? '').fontSize(14).fontWeight(FontWeight.Medium).fontColor(Color.White).textAlign(TextAlign.Center).width('100%').padding({ start: LengthMetrics.vp(14), end: LengthMetrics.vp(14), top: LengthMetrics.vp(10), bottom: LengthMetrics.vp(10)}).backgroundColor('#D1000000').borderRadius(50)
        }.width('100%').height('100%').padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), bottom: LengthMetrics.vp(28)}).hitTestBehavior(HitTestMode.Transparent)
      }
      if (this.isKeyboardPresented && !this.isPadDevice) {
        Column() {
          Blank()
          Row() {
            Blank()
            Button() { Image($r('app.media.ic_keyboard_chevron_compact_down_fill')).width(28).height(28).objectFit(ImageFit.Contain).fillColor($r('sys.color.font_secondary')).accessibilityLevel('no') }.width(36).height(36).padding(0).backgroundColor(Color.Transparent).margin({ end: LengthMetrics.vp(12), bottom: LengthMetrics.vp(this.keyboardBottomInset + 2)}).accessibilityText('Dismiss keyboard').id('translation_dismiss_keyboard').onClick(() => { this.dismissKeyboard(); })
          }.width('100%')
        }.width('100%').height('100%').hitTestBehavior(HitTestMode.Transparent)
      }
      if (this.model().tfMenuPreparationConfiguration) {
        TFMenuPreparationTaskHost({
          configuration: this.model().tfMenuPreparationConfiguration,
          generation: this.model().tfMenuPreparationGeneration
        })
      }
      if (this.model().unsafeRecoveryController?.configuration) {
        TranslationUnsafeRecoveryTaskHost({
          configuration: this.model().unsafeRecoveryController?.configuration,
          generation: this.model().unsafeRecoveryController?.requestGeneration ?? ''
        })
      }
    }
    .linearGradient({ direction: GradientDirection.RightBottom, colors: [[this.gradientTop(), 0], [this.gradientBottom(), 1]] })
    .id('screen_translation')
    .width('100%')
    .height('100%')
    .onAreaChange((oldArea: Area, newArea: Area) => {
      this.pageHeight = Number(newArea.height);
      this.wideLayout = Number(newArea.width) >= 600 && Number(newArea.width) > Number(newArea.height);
      this.updateKeyboardAvoidance();
      this.updateKeyboardPresentation(this.keyboardHeightPx);
    })
  }
}
