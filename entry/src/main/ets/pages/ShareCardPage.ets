import { UIExtensionContentSession, Want } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { i18n } from '@kit.LocalizationKit';
import { SharedImportStore } from '../common/SharedImportStore';
import { SharedFileText } from '../common/SharedFileText';
import { ImportService } from '../common/ImportService';

interface PendingImage {
  data: ArrayBuffer;
  fileExtension?: string;
}

// The iOS Share Extension card (ShareViewController.swift): the shared text under Cancel / Preserve.
// Preserve stores the text (or image) for zen-Babel to pick up on its next launch or foreground.
@Entry({ storage: LocalStorage.getShared() })
@Component
struct ShareCardPage {
  @LocalStorageProp('want') want: Want = {};
  private session?: UIExtensionContentSession = LocalStorage.getShared().get<UIExtensionContentSession>('session');
  private readonly japanese: boolean = i18n.System.getSystemLanguage().startsWith('ja');
  @State private preview: string = this.japanese ? '読み込み中...' : 'Loading...';
  @State private canPreserve: boolean = false;
  private sharedText: string = '';
  private image?: PendingImage;

  aboutToAppear(): void {
    this.load().catch((error: Error) => {
      console.error(`Share card: ${error.message}`);
      this.preview = this.japanese ? '共有可能なテキストが見つかりませんでした。' : 'No shareable text was found.';
    });
  }

  private async load(): Promise<void> {
    const data: systemShare.SharedData = await systemShare.getSharedData(this.want);
    const context: Context = this.getUIContext().getHostContext() as Context;
    const fragments: string[] = [];
    for (const record of data.getRecords()) {
      const text: string = (record.content ?? '').trim();
      if (text.length > 0) {
        fragments.push(text);
      } else if (record.uri !== undefined && this.isImage(record.utd, record.uri)) {
        if (this.image === undefined) {
          const bytes: ArrayBuffer = SharedFileText.readBytes(record.uri);
          const extension: string = SharedFileText.extension(record.uri);
          this.image = bytes.byteLength > 0 ? { data: bytes, fileExtension: extension.length > 0 ? extension : undefined } : undefined;
        }
      } else if (record.uri !== undefined) {
        const fileText: string | undefined = await SharedFileText.read(context, record.uri);
        if (fileText !== undefined) {
          fragments.push(fileText);
        }
      }
    }
    this.sharedText = fragments.join('\n');
    const hasText: boolean = this.sharedText.trim().length > 0;
    if (hasText) {
      this.preview = this.sharedText;
    } else if (this.image !== undefined) {
      this.preview = this.japanese ? '画像を予約しました。zenバベル起動時にOCRを実行します。' :
        'Image reserved. OCR will run when zen-Babel launches.';
    } else {
      this.preview = this.japanese ? '共有可能なテキストが見つかりませんでした。' : 'No shareable text was found.';
    }
    this.canPreserve = hasText || this.image !== undefined;
  }

  private isImage(utd: string, uri: string): boolean {
    return /image|jpeg|png|heic|heif|webp|gif|bmp|tiff/.test(utd) || ImportService.isImageExtension(SharedFileText.extension(uri));
  }

  private async preserve(): Promise<void> {
    const trimmed: string = this.sharedText.trim();
    if (trimmed.length === 0 && this.image === undefined) {
      return;
    }
    this.canPreserve = false;
    if (trimmed.length > 0) {
      await SharedImportStore.savePendingText(trimmed);
    } else if (this.image !== undefined) {
      await SharedImportStore.savePendingImageData(this.image.data, this.image.fileExtension);
    }
    this.getUIContext().showAlertDialog({
      message: this.japanese ? '予約完了。zenバベルを開いてください' : 'Reserved. Please open zen-Babel.',
      autoCancel: false,
      confirm: { value: 'OK', action: () => { this.close(); } }
    });
  }

  // CLOSE dismisses the whole share panel and returns to the host app, as the iOS extension does;
  // a plain terminateSelf() only goes back to the panel.
  private close(): void {
    this.session?.terminateSelfWithResult({ resultCode: systemShare.ShareAbilityResultCode.CLOSE });
  }

  @Builder
  cardButton(title: string, primary: boolean, action: () => void) {
    Button(title)
      .layoutWeight(1)
      .height(40)
      .borderRadius(20)
      .fontSize(17)
      .fontWeight(FontWeight.Medium)
      .backgroundColor(primary ? $r('sys.color.brand') : $r('app.color.share_card_button_secondary'))
      .fontColor(primary ? Color.White : $r('sys.color.font_primary'))
      .opacity(!primary || this.canPreserve ? 1 : 0.6)
      .enabled(!primary || this.canPreserve)
      .onClick(action)
  }

  build() {
    Column() {
      Column({ space: 16 }) {
        Row({ space: 10 }) {
          this.cardButton(this.japanese ? 'キャンセル' : 'Cancel', false, () => { this.close(); })
          this.cardButton(this.japanese ? '予約' : 'Preserve', true, () => { this.preserve(); })
        }
        .id('share_card_buttons')
        .width('100%')

        Scroll() {
          Text(this.preview)
            .id('share_card_preview')
            .fontSize(17)
            .fontColor($r('sys.color.font_primary'))
            .width('100%')
        }
        .constraintSize({ minHeight: 110, maxHeight: 320 })
        .align(Alignment.TopStart)
        .scrollBar(BarState.Auto)
      }
      .id('share_card')
      .padding(16)
      // iOS: .secondarySystemBackground card and .systemGray5 secondary button (ShareViewController.swift:602, 662).
      .backgroundColor($r('app.color.share_card_background'))
      .borderRadius(18)
      .margin({ left: 16, right: 16 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#52000000')
  }
}
