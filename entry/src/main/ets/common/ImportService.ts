import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { image } from '@kit.ImageKit';
import { textRecognition } from '@kit.CoreVisionKit';
import { pdfService } from '@kit.PDFKit';
import { i18n } from '@kit.LocalizationKit';
import { describeError } from './ErrorText';
import { SharedImportStore, PendingImport } from './SharedImportStore';
import { SharedFileText } from './SharedFileText';
import { TranslationViewModel } from './TranslationViewModel';

export enum ImportFailureKind {
  CANCELLED = 'cancelled', BUSY = 'busy', UNAVAILABLE = 'unavailable',
  UNSUPPORTED = 'unsupported', EMPTY = 'empty', OCR = 'ocr',
  PDF = 'pdf', PASSWORD = 'password', NO_PDF_TEXT = 'noPdfText',
  DECODE = 'decode', FILE = 'file', TIMEOUT = 'timeout'
}

export class ImportError extends Error {
  readonly kind: ImportFailureKind;
  constructor(kind: ImportFailureKind, message: string) { super(message); this.kind = kind; }
}

export enum ImportToastPlacement { BOTTOM = 'bottom', SOURCE_FIELD_CENTER = 'sourceFieldCenter' }

export type ImportProgressHandler = (text: string, pageNumber: number, pageCount: number) => void;

class ImportTask {
  cancelled: boolean = false;
  reject?: (error: Error) => void;
  timer?: number;
  originalText: string;
  streamedText?: string;
  translating: boolean = false;
  placement: ImportToastPlacement = ImportToastPlacement.BOTTOM;
  constructor(originalText: string) { this.originalText = originalText; }
  check(): void {
    if (this.cancelled) { throw new ImportError(ImportFailureKind.CANCELLED, 'Import cancelled.'); }
  }
}

export class ImportService {
  isImportLoading: boolean = false;
  isFileImportPickerPresented: boolean = false;
  isPhotoPickerPresented: boolean = false;
  importToastMessage?: string;
  importToastPlacement: ImportToastPlacement = ImportToastPlacement.BOTTOM;
  error?: ImportError;
  // Apple OCR controls are retained as intent; CoreVisionKit exposes none of these setters.
  readonly recognitionLevel: string = 'accurate';
  readonly usesLanguageCorrection: boolean = true;
  recognitionLanguages: string[] = [];
  supportedRecognitionLanguages: string[] = [];
  private static ocrBusy: boolean = false;
  private static pickerBusy: boolean = false;
  private context?: common.Context;
  private activeTask?: ImportTask;
  private toastDismissTask?: number;
  private observers: ((service: ImportService) => void)[] = [];
  private unsubscribeModel?: () => void;
  private applyingText: boolean = false;
  private viewModel: TranslationViewModel;
  private preferredLanguages: string[];

  constructor(viewModel: TranslationViewModel, preferredLanguages: string[] = i18n.System.getPreferredLanguageList()) {
    this.viewModel = viewModel;
    this.preferredLanguages = preferredLanguages;
  }

  initialize(context: common.Context): void {
    this.context = context;
    SharedImportStore.initialize(context);
    if (this.unsubscribeModel) { this.unsubscribeModel(); }
    this.unsubscribeModel = this.viewModel.observe((model: TranslationViewModel) => {
      const task: ImportTask | undefined = this.activeTask;
      if (task && !task.translating && !this.applyingText &&
        model.inputText !== (task.streamedText ?? task.originalText)) { this.cancelImport(); }
    });
  }

  observe(observer: (service: ImportService) => void): () => void {
    this.observers.push(observer);
    observer(this);
    return () => { this.observers = this.observers.filter((item: (service: ImportService) => void) => item !== observer); };
  }

  dispose(): void {
    this.cancelImport();
    if (this.unsubscribeModel) { this.unsubscribeModel(); this.unsubscribeModel = undefined; }
    if (this.toastDismissTask !== undefined) { clearTimeout(this.toastDismissTask); this.toastDismissTask = undefined; }
    this.importToastMessage = undefined;
    this.observers = [];
  }

  cancelImport(): void {
    const task: ImportTask | undefined = this.activeTask;
    if (!task) { return; }
    this.cancelTask(task, new ImportError(ImportFailureKind.CANCELLED, 'Import cancelled.'));
    this.notify();
  }

  async presentFileImporter(): Promise<string | undefined> {
    return this.run(async (task: ImportTask): Promise<string | undefined> => {
      if (ImportService.pickerBusy) { throw new ImportError(ImportFailureKind.BUSY, 'A file or photo picker is still open.'); }
      ImportService.pickerBusy = true;
      this.isFileImportPickerPresented = true;
      this.notify();
      let uris: string[];
      this.pauseTimeout(task);
      try {
        const options: picker.DocumentSelectOptions = {
          maxSelectNumber: 1, fileSuffixFilters: ['Documents|.txt,.pdf,.doc,.docx,.pages', 'Images|.jpg,.jpeg,.png,.heic,.heif,.webp,.gif,.bmp,.tif,.tiff']
        };
        uris = await new picker.DocumentViewPicker(this.requireContext()).select(options);
      } finally { ImportService.pickerBusy = false; this.armTimeout(task); }
      task.check();
      this.isFileImportPickerPresented = false;
      this.notify();
      if (uris.length === 0) { return undefined; }
      const text: string = await this.loadTextCore(uris[0], task, undefined, undefined, true);
      this.applyImportedText(text, task);
      return text;
    });
  }

  async presentPhotoPicker(): Promise<string | undefined> {
    return this.run(async (task: ImportTask): Promise<string | undefined> => {
      if (ImportService.pickerBusy) { throw new ImportError(ImportFailureKind.BUSY, 'A file or photo picker is still open.'); }
      ImportService.pickerBusy = true;
      this.isPhotoPickerPresented = true;
      this.notify();
      let selection: photoAccessHelper.PhotoSelectResult;
      this.pauseTimeout(task);
      try {
        const options: photoAccessHelper.PhotoSelectOptions = {
          MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE, maxSelectNumber: 1
        };
        selection = await new photoAccessHelper.PhotoViewPicker().select(options);
      } finally { ImportService.pickerBusy = false; this.armTimeout(task); }
      task.check();
      this.isPhotoPickerPresented = false;
      this.notify();
      if (selection.photoUris.length === 0) { return undefined; }
      const text: string = await this.recognizeCore(await this.readBytes(selection.photoUris[0], task), task);
      this.applyImportedText(text, task);
      return text;
    }, ImportToastPlacement.SOURCE_FIELD_CENTER);
  }

  async handleImportedDocumentResult(uri: string, password?: string, onProgress?: ImportProgressHandler): Promise<string> {
    const placement: ImportToastPlacement = ImportService.isImageExtension(this.extension(uri))
      ? ImportToastPlacement.SOURCE_FIELD_CENTER : ImportToastPlacement.BOTTOM;
    const text: string | undefined = await this.run(async (task: ImportTask): Promise<string> => {
      const result: string = await this.loadTextCore(uri, task, password, onProgress, true);
      this.applyImportedText(result, task);
      return result;
    }, placement);
    return text ?? '';
  }

  async handlePickedPhotoItem(uri: string): Promise<string> {
    return this.importImageDataFromURI(uri);
  }

  async handlePastedImageOnIOS(data: ArrayBuffer): Promise<string> {
    return this.importImageData(data);
  }

  async importImageData(data: ArrayBuffer): Promise<string> {
    const text: string | undefined = await this.run(async (task: ImportTask): Promise<string> => {
      const result: string = await this.recognizeCore(data, task);
      this.applyImportedText(result, task);
      return result;
    }, ImportToastPlacement.SOURCE_FIELD_CENTER);
    return text ?? '';
  }

  async importImageDataFromURI(uri: string): Promise<string> {
    const text: string | undefined = await this.run(async (task: ImportTask): Promise<string> => {
      const result: string = await this.recognizeCore(await this.readBytes(uri, task), task);
      this.applyImportedText(result, task);
      return result;
    }, ImportToastPlacement.SOURCE_FIELD_CENTER);
    return text ?? '';
  }

  async loadImportedText(uri: string, password?: string): Promise<string> {
    const text: string | undefined = await this.run((task: ImportTask): Promise<string> => this.loadTextCore(uri, task, password));
    return text ?? '';
  }

  async recognizeTextInImageData(data: ArrayBuffer): Promise<string> {
    const text: string | undefined = await this.run((task: ImportTask): Promise<string> => this.recognizeCore(data, task),
      ImportToastPlacement.SOURCE_FIELD_CENTER);
    return text ?? '';
  }

  async extractTextFromImageDataOnIOS(data: ArrayBuffer): Promise<string> { return this.recognizeTextInImageData(data); }

  async extractTextFromPDFOnIOS(uri: string, password?: string): Promise<string> {
    const text: string | undefined = await this.run((task: ImportTask): Promise<string> => this.pdfCore(uri, task, password));
    return text ?? '';
  }

  async importPDFToSourceStreamingOnIOS(uri: string, onProgress?: ImportProgressHandler, password?: string): Promise<string> {
    return this.handleImportedDocumentResult(uri, password, onProgress);
  }

  async extractTextWithAttributedStringOnIOS(uri: string): Promise<string> {
    return this.loadImportedText(uri);
  }

  async handleSharedImportIfNeeded(): Promise<string | undefined> {
    // Consume before starting a task: launch and foreground both call this, and an empty run() would
    // clear the 'Shared text imported.' toast the first call just showed.
    const pending: PendingImport | undefined = await SharedImportStore.consumePendingImport();
    if (!pending) { return undefined; }
    return this.run(async (task: ImportTask): Promise<string | undefined> => {
      let text: string;
      if (pending.kind === 'image') {
        task.placement = ImportToastPlacement.SOURCE_FIELD_CENTER;
        const path: string = pending.imageFile ?? '';
        try {
          task.check();
          text = await this.recognizeCore(await this.readBytes(path, task), task);
        } finally { if (path.length > 0) { SharedImportStore.releaseImageFile(path); } }
      } else { task.check(); text = (pending.text ?? '').trim(); }
      if (text.trim().length === 0) { throw new ImportError(ImportFailureKind.EMPTY, 'Shared content contains no text.'); }
      this.applyImportedText(text, task);
      this.showImportToast(this.localized('ui_import_shared_text_imported', 'Shared text imported.'));
      this.viewModel.reloadSettings();
      if (this.viewModel.autoTranslateImportedTextEnabled) {
        task.translating = true;
        this.isImportLoading = false;
        if (task.timer !== undefined) { clearTimeout(task.timer); task.timer = undefined; }
        this.notify();
        await this.viewModel.translate();
        task.check();
      }
      return text;
    }).catch((error: Error): undefined => {
      // run() has already shown the failure as a toast; iOS shows nothing more (no status-line error).
      if (error instanceof ImportError) { return undefined; }
      throw error;
    });
  }

  showImportToast(message: string, placement: ImportToastPlacement = ImportToastPlacement.BOTTOM): void {
    if (this.toastDismissTask !== undefined) { clearTimeout(this.toastDismissTask); }
    this.importToastMessage = message;
    this.importToastPlacement = placement;
    this.toastDismissTask = setTimeout(() => {
      this.toastDismissTask = undefined;
      this.importToastMessage = undefined;
      this.importToastPlacement = ImportToastPlacement.BOTTOM;
      this.notify();
    }, 2000);
    this.notify();
  }

  // The 30 s limit guards native work (decoding, OCR, PDF). It is paused while a picker is open: the time the
  // user spends choosing a file must not cancel the import.
  private armTimeout(task: ImportTask): void {
    this.pauseTimeout(task);
    task.timer = setTimeout(() => {
      if (this.activeTask !== task) { return; }
      const error: ImportError = new ImportError(ImportFailureKind.TIMEOUT, 'Import timed out. Native work may still be busy; please retry after it finishes.');
      this.error = error;
      this.cancelTask(task, error);
      this.showImportToast(error.message, task.placement);
    }, 30000);
  }

  private pauseTimeout(task: ImportTask): void {
    if (task.timer !== undefined) { clearTimeout(task.timer); task.timer = undefined; }
  }

  private run(work: (task: ImportTask) => Promise<string | undefined>,
    placement: ImportToastPlacement = ImportToastPlacement.BOTTOM): Promise<string | undefined> {
    this.requireContext();
    this.cancelImport();
    const task: ImportTask = new ImportTask(this.viewModel.inputText);
    task.placement = placement;
    this.activeTask = task;
    this.error = undefined;
    this.importToastMessage = undefined;
    this.isImportLoading = true;
    this.notify();
    return new Promise<string | undefined>((resolve, reject) => {
      task.reject = reject;
      this.armTimeout(task);
      work(task).then((text: string | undefined) => {
        if (this.activeTask !== task || task.cancelled) { return; }
        this.finish(task);
        resolve(text);
      }).catch((cause: BusinessError) => {
        if (this.activeTask !== task || task.cancelled) { return; }
        const error: ImportError = cause instanceof ImportError ? cause
          : new ImportError(ImportFailureKind.FILE, describeError(cause));
        this.restoreSource(task);
        this.error = error;
        this.finish(task);
        if (error.kind !== ImportFailureKind.CANCELLED) { this.showImportToast(error.message, task.placement); }
        reject(error);
      });
    });
  }

  private finish(task: ImportTask): void {
    if (task.timer !== undefined) { clearTimeout(task.timer); task.timer = undefined; }
    task.reject = undefined;
    this.activeTask = undefined;
    this.isImportLoading = false;
    this.isFileImportPickerPresented = false;
    this.isPhotoPickerPresented = false;
    this.notify();
  }

  private cancelTask(task: ImportTask, error: ImportError): void {
    task.cancelled = true;
    const reject: ((error: Error) => void) | undefined = task.reject;
    this.restoreSource(task);
    if (task.translating) { this.viewModel.stopTranslation(); }
    this.finish(task);
    if (reject) { reject(error); }
  }

  private restoreSource(task: ImportTask): void {
    if (task.streamedText !== undefined && this.viewModel.inputText === task.streamedText) {
      this.applyingText = true;
      try { this.viewModel.handleSourceTextPasted(task.originalText); }
      finally { this.applyingText = false; }
    }
  }

  private applyImportedText(text: string, task: ImportTask): void {
    task.check();
    if (text.trim().length === 0) { throw new ImportError(ImportFailureKind.EMPTY, 'This file contains no text.'); }
    this.applyingText = true;
    try { this.viewModel.handleSourceTextPasted(text); task.originalText = this.viewModel.inputText; task.streamedText = undefined; }
    finally { this.applyingText = false; }
  }

  private async loadTextCore(uri: string, task: ImportTask, password?: string,
    onProgress?: ImportProgressHandler, stream: boolean = false): Promise<string> {
    task.check();
    const extension: string = this.extension(uri);
    if (extension === 'pdf') { return this.pdfCore(uri, task, password, onProgress, stream); }
    if (ImportService.isImageExtension(extension)) { return this.recognizeCore(await this.readBytes(uri, task), task); }
    // iOS reads Word files through NSAttributedString; .docx uses the share card's word/document.xml reader.
    // ponytail: binary .doc, .pages, .rtf and .odt stay unsupported; add readers if those files show up.
    if (extension === 'docx') {
      const text: string | undefined = await SharedFileText.docxText(this.requireContext(), await this.readBytes(uri, task));
      task.check();
      if (text !== undefined && text.trim().length > 0) { return text.trim(); }
      throw new ImportError(ImportFailureKind.EMPTY, 'This file contains no text.');
    }
    if (['doc', 'pages', 'rtf', 'odt'].includes(extension)) {
      throw new ImportError(ImportFailureKind.UNSUPPORTED, 'Office and Pages text import is not available on this platform. Export the document as TXT or a text PDF.');
    }
    if (extension !== 'txt' && extension !== 'text') {
      throw new ImportError(ImportFailureKind.UNSUPPORTED, 'This file does not contain supported text content.');
    }
    return ImportService.decodeText(await this.readBytes(uri, task));
  }

  private async recognizeCore(data: ArrayBuffer, task: ImportTask): Promise<string> {
    task.check();
    if (data.byteLength === 0) { throw new ImportError(ImportFailureKind.EMPTY, 'The image is empty.'); }
    if (ImportService.ocrBusy) { throw new ImportError(ImportFailureKind.BUSY, 'Text recognition is still busy with a previous image. Please retry after it finishes.'); }
    ImportService.ocrBusy = true;
    let source: image.ImageSource | undefined;
    let pixelMap: image.PixelMap | undefined;
    let attemptedInitialization: boolean = false;
    try {
      source = image.createImageSource(data);
      pixelMap = await source.createPixelMap();
      task.check();
      attemptedInitialization = true;
      if (!await textRecognition.init()) { throw new ImportError(ImportFailureKind.UNAVAILABLE, 'Text recognition is not available on this device.'); }
      task.check();
      const supportedLanguages: string[] = await textRecognition.getSupportedLanguages();
      task.check();
      this.supportedRecognitionLanguages = supportedLanguages;
      this.recognitionLanguages = this.recognitionLanguageCandidatesForOCR().filter((candidate: string) =>
        this.supportedRecognitionLanguages.some((supported: string) => ImportService.normalizeOCRLanguageCode(supported) === candidate));
      const info: textRecognition.VisionInfo = { pixelMap: pixelMap };
      const configuration: textRecognition.TextRecognitionConfiguration = { isDirectionDetectionSupported: true };
      const result: textRecognition.TextRecognitionResult = await textRecognition.recognizeText(info, configuration);
      task.check();
      const lines: string[] = [];
      for (const block of result.blocks) { for (const line of block.lines) { lines.push(line.value); } }
      const normalized: string | undefined = ImportService.normalizedRecognizedImageImportText(lines.length > 0 ? lines.join('\n') : result.value);
      if (!normalized) { throw new ImportError(ImportFailureKind.OCR, 'Could not read text.'); }
      return normalized;
    } catch (cause) {
      if (cause instanceof ImportError) { throw cause; }
      throw new ImportError(ImportFailureKind.OCR, `Could not read text. ${describeError(cause as BusinessError)}`);
    } finally {
      try {
        if (pixelMap) { await pixelMap.release(); }
      } finally {
        try { if (source) { await source.release(); } }
        finally {
          try { if (attemptedInitialization) { await textRecognition.release(); } }
          finally { ImportService.ocrBusy = false; }
        }
      }
    }
  }

  private async pdfCore(uri: string, task: ImportTask, password?: string,
    onProgress?: ImportProgressHandler, stream: boolean = false): Promise<string> {
    const bytes: ArrayBuffer = await this.readBytes(uri, task);
    task.check();
    const path: string = `${this.requireContext().cacheDir}/${util.generateRandomUUID()}.pdf`;
    try {
      await this.writeBytes(path, bytes, task);
      task.check();
      const document: pdfService.PdfDocument = new pdfService.PdfDocument();
      try {
        // shortcut: SDK PDF calls are synchronous, move to a verified thread-safe worker API when one is available.
        const parsed: pdfService.ParseResult = document.loadDocument(path, password);
        task.check();
        if (parsed === pdfService.ParseResult.PARSE_ERROR_PASSWORD) {
          throw new ImportError(ImportFailureKind.PASSWORD, 'The PDF requires a valid password.');
        }
        if (parsed !== pdfService.ParseResult.PARSE_SUCCESS) {
          throw new ImportError(ImportFailureKind.PDF, `Could not open this PDF (parse result ${parsed}).`);
        }
        const count: number = document.getPageCount();
        if (count <= 0) { throw new ImportError(ImportFailureKind.EMPTY, 'The PDF has no pages.'); }
        const chunks: string[] = [];
        for (let index: number = 0; index < count; index++) {
          task.check();
          const page: pdfService.PdfPage = document.getPage(index);
          let text: string;
          try { text = page.getTextContent().trim(); }
          finally { page.release(); }
          task.check();
          if (text.length > 0) {
            chunks.push(`${ImportService.pdfPageMarker(count, index + 1)}\n\n${ImportService.normalizePDFSoftLineBreaksOnIOS(text)}`);
            const combined: string = chunks.join('\n\n');
            if (stream) {
              task.streamedText = combined;
              this.applyingText = true;
              try { this.viewModel.inputText = combined; this.viewModel.notifyStateChanged(); }
              finally { this.applyingText = false; }
            }
            if (onProgress) { onProgress(combined, index + 1, count); }
          }
          await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        }
        task.check();
        if (chunks.length === 0) { throw new ImportError(ImportFailureKind.NO_PDF_TEXT, 'This PDF contains no extractable text. Scanned pages require image OCR.'); }
        return chunks.join('\n\n');
      } finally { document.releaseDocument(); }
    } finally { if (fs.accessSync(path)) { await fs.unlink(path); } }
  }

  private async readBytes(uri: string, task: ImportTask): Promise<ArrayBuffer> {
    this.validateURI(uri);
    task.check();
    const file: fs.File = await fs.open(uri, fs.OpenMode.READ_ONLY);
    try {
      task.check();
      const stat: fs.Stat = await fs.stat(file.fd);
      if (!stat.isFile() || stat.size <= 0) { throw new ImportError(ImportFailureKind.EMPTY, 'The selected file is empty or is a directory.'); }
      const data: ArrayBuffer = new ArrayBuffer(stat.size);
      const destination: Uint8Array = new Uint8Array(data);
      let position: number = 0;
      while (position < stat.size) {
        task.check();
        const chunk: ArrayBuffer = new ArrayBuffer(Math.min(65536, stat.size - position));
        const length: number = await fs.read(file.fd, chunk);
        task.check();
        if (length <= 0 || length > chunk.byteLength) { throw new ImportError(ImportFailureKind.FILE, 'The selected file could not be read completely.'); }
        destination.set(new Uint8Array(chunk, 0, length), position);
        position += length;
      }
      return data;
    } finally { await fs.close(file); }
  }

  private async writeBytes(path: string, data: ArrayBuffer, task: ImportTask): Promise<void> {
    const file: fs.File = await fs.open(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY);
    try {
      let position: number = 0;
      while (position < data.byteLength) {
        task.check();
        const chunk: ArrayBuffer = data.slice(position, Math.min(position + 65536, data.byteLength));
        const written: number = await fs.write(file.fd, chunk);
        if (written <= 0 || written > chunk.byteLength) { throw new ImportError(ImportFailureKind.FILE, 'Could not copy the PDF into the app sandbox.'); }
        position += written;
      }
    } finally { await fs.close(file); }
  }

  private validateURI(uri: string): void {
    let decoded: string;
    try { decoded = decodeURIComponent(uri); }
    catch (cause) { throw new ImportError(ImportFailureKind.FILE, 'Invalid file URI.'); }
    if (/[\0\\%?#]/.test(decoded) || decoded.split('/').some((part: string) => part === '..' || part === '.')) {
      throw new ImportError(ImportFailureKind.FILE, 'Invalid file URI.');
    }
    if (/^file:\/\/(docs|media)\//.test(decoded) || /^datashare:\/\/\/media\//.test(decoded)) { return; }
    const path: string = decoded.startsWith('file:///') ? decoded.substring(7) : decoded;
    const context: common.Context = this.requireContext();
    if (!path.startsWith(`${context.filesDir}/`) && !path.startsWith(`${context.cacheDir}/`)) {
      throw new ImportError(ImportFailureKind.FILE, 'Choose the file using the system picker to grant read access.');
    }
    const parts: string[] = path.split('/');
    let prefix: string = '';
    for (const part of parts) {
      if (part.length === 0) { continue; }
      prefix += '/' + part;
      if (fs.lstatSync(prefix).isSymbolicLink()) { throw new ImportError(ImportFailureKind.FILE, 'Symbolic link imports are not allowed.'); }
    }
  }

  private extension(uri: string): string {
    let decoded: string;
    try { decoded = decodeURIComponent(uri); } catch (cause) { return ''; }
    const filename: string = decoded.substring(decoded.lastIndexOf('/') + 1);
    const dot: number = filename.lastIndexOf('.');
    return dot < 0 ? '' : filename.substring(dot + 1).toLowerCase();
  }

  static isImageExtension(extension: string): boolean { return /^(jpg|jpeg|png|gif|bmp|webp|heic|heif|tif|tiff)$/.test(extension.toLowerCase()); }

  static decodeText(data: ArrayBuffer): string {
    const bytes: Uint8Array = new Uint8Array(data);
    if (bytes.length === 0) { throw new ImportError(ImportFailureKind.EMPTY, 'The text file is empty.'); }
    const utf16Encoding: string = bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : 'utf-16be';
    const encodings: string[] = ['utf-8', utf16Encoding, 'shift_jis'];
    const failures: string[] = [];
    for (const encoding of encodings) {
      try {
        const options: util.TextDecoderOptions = { fatal: true, ignoreBOM: encoding === 'utf-8' };
        const decoder: util.TextDecoder = util.TextDecoder.create(encoding, options);
        const text: string = decoder.decodeToString(bytes);
        if (text.trim().length > 0) { return text; }
      } catch (cause) { failures.push(`${encoding}: ${describeError(cause as BusinessError)}`); }
    }
    throw new ImportError(ImportFailureKind.DECODE, `Could not decode nonempty text as UTF-8, UTF-16 or Shift JIS. ${failures.join('; ')}`);
  }

  static normalizeOCRLanguageCode(code: string): string {
    const trimmed: string = code.trim().replace(/_/g, '-');
    if (trimmed.length === 0 || trimmed.toLowerCase() === 'und') { return ''; }
    const parts: string[] = trimmed.split('-').filter((part: string) => part.length > 0);
    return parts.map((part: string, index: number) => index === 0 ? part.toLowerCase()
      : part.length === 4 ? part.substring(0, 1).toUpperCase() + part.substring(1).toLowerCase()
      : part.length === 2 || part.length === 3 ? part.toUpperCase() : part).join('-');
  }

  recognitionLanguageCandidatesForOCR(): string[] {
    const map: Map<string, string> = new Map<string, string>();
    for (const preferred of this.preferredLanguages) {
      const normalized: string = ImportService.normalizeOCRLanguageCode(preferred);
      const base: string = normalized.split('-')[0];
      if (base.length > 0 && !map.has(base)) { map.set(base, normalized); }
    }
    const seeds: string[] = [this.preferredLanguages[0] ?? '', this.viewModel.detectedLanguageCode, this.viewModel.targetLanguage];
    const candidates: string[] = [];
    for (const seed of seeds) {
      const normalized: string = ImportService.normalizeOCRLanguageCode(seed);
      if (normalized.length === 0) { continue; }
      const base: string = normalized.split('-')[0];
      for (const candidate of [map.get(base) ?? '', normalized, base]) {
        if (candidate.length > 0 && !candidates.includes(candidate)) { candidates.push(candidate); }
      }
    }
    return candidates;
  }

  static normalizedRecognizedImageImportText(text: string): string | undefined {
    const normalized: string = this.normalizePDFSoftLineBreaksOnIOS(text).trim();
    return normalized.length === 0 ? undefined : normalized;
  }

  static pdfPageMarker(pageCount: number, pageNumber: number): string { return `- ${pageNumber} / ${pageCount} -`; }

  static normalizePDFSoftLineBreaksOnIOS(text: string): string {
    // HarmonyOS PDF text ends lines with CRLF where iOS PDFKit gives LF; one CRLF is one line break.
    const lines: string[] = text.split(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/);
    // shortcut: heading thresholds count Unicode scalars, use verified grapheme segmentation for full Swift Character parity.
    let introMax: number = 0;
    for (const line of lines.slice(0, 30)) { introMax = Math.max(introMax, Array.from(line.trim()).length); }
    const threshold: number = Math.floor(introMax / 2);
    const result: string[] = [];
    let previousForcesBreak: boolean = true;
    let vertical: boolean = false;
    for (let index: number = 0; index < lines.length; index++) {
      const line: string = lines[index].trim();
      if (line.length === 0) {
        if (result.length > 0 && result[result.length - 1] !== '') { result.push(''); }
        previousForcesBreak = true; vertical = false; continue;
      }
      if (!vertical) {
        let count: number = 0;
        for (let cursor: number = index; cursor < lines.length; cursor++) {
          const chars: string[] = Array.from(lines[cursor].trim());
          if (chars.length !== 1 || !this.isCJKExcludingHangul(chars[0].codePointAt(0) ?? 0)) { break; }
          count++;
        }
        vertical = count >= 3;
      }
      const marker: boolean = this.shouldKeepLineBreakOnIOS(line);
      const quoteNext: boolean = marker && this.isQuotationOnlyLineOnIOS((lines[index + 1] ?? '').trim());
      const bullet: boolean = /^[・＊ー-]/.test(line) || /^\p{N}+[.:;]/u.test(line);
      const numeric: boolean = /^[0-9/:\s]+$/.test(line);
      const short: boolean = threshold > 0 && Array.from(line).length <= threshold;
      const last: string = result[result.length - 1] ?? '';
      if (vertical && last.length > 0) { result[result.length - 1] = last + line; }
      else if (!vertical && !previousForcesBreak && !bullet && !numeric && last.length > 0) {
        const chars: string[] = Array.from(last.trimEnd());
        const trailing: string = chars[chars.length - 1] ?? '';
        const joinWithoutSpace: boolean = this.isQuotationOnlyLineOnIOS(line) || this.isCJKExcludingHangul(trailing.codePointAt(0) ?? 0);
        result[result.length - 1] = last + (joinWithoutSpace ? '' : ' ') + line;
      } else { result.push(line); }
      if (marker) { vertical = false; }
      previousForcesBreak = quoteNext ? false : marker || bullet || numeric || short;
    }
    return result.join('\n');
  }

  private static isQuotationOnlyLineOnIOS(line: string): boolean { return line.length > 0 && /^["'”“’‘»«›‹]+$/.test(line); }

  private static shouldKeepLineBreakOnIOS(line: string): boolean {
    const unquoted: string = line.trim().replace(/["'”“’‘»«›‹]+$/, '');
    return /[.。!?！？)\]}）］｝〉》」』】〙〗]$/.test(unquoted);
  }

  private static isCJKExcludingHangul(value: number): boolean {
    return (value >= 0x2e80 && value <= 0x2eff) || (value >= 0x3000 && value <= 0x303f) ||
      (value >= 0x3040 && value <= 0x30ff) || (value >= 0x31f0 && value <= 0x31ff) ||
      (value >= 0x3400 && value <= 0x4dbf) || (value >= 0x4e00 && value <= 0x9fff) ||
      (value >= 0xf900 && value <= 0xfaff) || (value >= 0x20000 && value <= 0x2a6df) ||
      (value >= 0x2a700 && value <= 0x2b73f) || (value >= 0x2b740 && value <= 0x2b81f) ||
      (value >= 0x2b820 && value <= 0x2ceaf) || (value >= 0x2ceb0 && value <= 0x2ebef) ||
      (value >= 0x30000 && value <= 0x3134f);
  }

  private requireContext(): common.Context {
    if (!this.context) { throw new ImportError(ImportFailureKind.UNAVAILABLE, 'Initialize ImportService with an ability context before importing.'); }
    return this.context;
  }

  private localized(key: string, fallback: string): string {
    try { return this.requireContext().resourceManager.getStringByNameSync(key); }
    catch (cause) { return fallback; }
  }

  private notify(): void { for (const observer of this.observers.slice()) { observer(this); } }
}
