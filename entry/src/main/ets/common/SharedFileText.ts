import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { pdfService } from '@kit.PDFKit';
import { zlib } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { ImportService } from './ImportService';

// The share card's file reading, ported from iOS ShareViewController.readTextFile: PDF pages with
// '- n / N -' markers, Word documents, and plain text (UTF-8, UTF-16 or Shift JIS), capped at 10,000 characters.
export class SharedFileText {
  static readonly MAX_CHARACTERS: number = 10000;

  static readBytes(uri: string): ArrayBuffer {
    const file: fileIo.File = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    try {
      const size: number = fileIo.statSync(file.fd).size;
      const data: ArrayBuffer = new ArrayBuffer(size);
      let read: number = 0;
      while (read < size) {
        const count: number = fileIo.readSync(file.fd, data, { offset: read, length: size - read });
        if (count <= 0) {
          return data.slice(0, read);
        }
        read += count;
      }
      return data;
    } finally {
      fileIo.closeSync(file.fd);
    }
  }

  static extension(uri: string): string {
    let name: string = uri.substring(uri.lastIndexOf('/') + 1);
    try { name = decodeURIComponent(name); } catch (error) { /* keep the raw name */ }
    const dot: number = name.lastIndexOf('.');
    return dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
  }

  // Undefined when the file holds no readable text (empty, unparseable, binary).
  static async read(context: common.Context, uri: string): Promise<string | undefined> {
    const bytes: ArrayBuffer = SharedFileText.readBytes(uri);
    if (bytes.byteLength === 0) {
      return undefined;
    }
    const extension: string = SharedFileText.extension(uri);
    let text: string | undefined;
    if (extension === 'pdf') {
      text = await SharedFileText.pdfText(context, bytes);
    } else if (extension === 'docx') {
      text = await SharedFileText.docxText(context, bytes);
    } else {
      try { text = ImportService.decodeText(bytes); } catch (error) { text = undefined; }
    }
    const trimmed: string = (text ?? '').trim();
    return trimmed.length > 0 ? trimmed.substring(0, SharedFileText.MAX_CHARACTERS) : undefined;
  }

  private static scratchPath(context: common.Context, extension: string): string {
    return `${context.cacheDir}/share-${util.generateRandomUUID()}.${extension}`;
  }

  // iOS reads on a background thread; yielding after each page lets the card paint Loading... and stay responsive.
  private static async pdfText(context: common.Context, bytes: ArrayBuffer): Promise<string | undefined> {
    const path: string = SharedFileText.scratchPath(context, 'pdf');
    const file: fileIo.File = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
    try { fileIo.writeSync(file.fd, bytes); } finally { fileIo.closeSync(file.fd); }
    const document: pdfService.PdfDocument = new pdfService.PdfDocument();
    try {
      if (document.loadDocument(path) !== pdfService.ParseResult.PARSE_SUCCESS) {
        return undefined;
      }
      const count: number = document.getPageCount();
      const pages: string[] = [];
      for (let index: number = 0; index < count; index++) {
        const page: pdfService.PdfPage = document.getPage(index);
        let text: string;
        try { text = page.getTextContent().trim(); } finally { page.release(); }
        if (text.length > 0) {
          pages.push(`${ImportService.pdfPageMarker(count, index + 1)}\n\n${ImportService.normalizePDFSoftLineBreaksOnIOS(text)}`);
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      }
      return pages.join('\n\n');
    } finally {
      document.releaseDocument();
      fileIo.unlinkSync(path);
    }
  }

  // iOS reads Word files through NSAttributedString; here the paragraphs come from the .docx's word/document.xml.
  static async docxText(context: common.Context, bytes: ArrayBuffer): Promise<string | undefined> {
    const path: string = SharedFileText.scratchPath(context, 'docx');
    const directory: string = `${path}.d`;
    const file: fileIo.File = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
    try { fileIo.writeSync(file.fd, bytes); } finally { fileIo.closeSync(file.fd); }
    try {
      fileIo.mkdirSync(directory);
      await zlib.decompressFile(path, directory);
      const xmlPath: string = `${directory}/word/document.xml`;
      if (!fileIo.accessSync(xmlPath)) {
        return undefined;
      }
      const xml: string = fileIo.readTextSync(xmlPath);
      return xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:(br|cr)\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:instrText[^>]*>[^<]*<\/w:instrText>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
    } catch (error) {
      return undefined;
    } finally {
      fileIo.unlinkSync(path);
      if (fileIo.accessSync(directory)) {
        fileIo.rmdirSync(directory);
      }
    }
  }
}
