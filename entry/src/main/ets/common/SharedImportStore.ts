import { common, Want } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { fileIo, ReadOptions } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

export enum PendingImportKind {
  TEXT = 'text',
  IMAGE = 'image'
}

export interface PendingImport {
  kind: PendingImportKind;
  text?: string;
  imageFile?: string;
}

interface PendingPreferences {
  text: string;
  kind: string;
  imageRelativePath: string;
}

export class SharedImportStore {
  static readonly APP_GROUP_ID: string = 'group.com.ttrace.prebabellens';
  private static readonly PENDING_TEXT_KEY: string = 'pendingSharedText';
  private static readonly PENDING_DATE_KEY: string = 'pendingSharedDate';
  private static readonly PENDING_IMPORT_KIND_KEY: string = 'pendingSharedImportKind';
  private static readonly PENDING_IMAGE_RELATIVE_PATH_KEY: string = 'pendingSharedImageRelativePath';
  private static readonly SHARED_IMPORTS_DIRECTORY_NAME: string = 'SharedImports';
  private static readonly PASTEBOARD_NAME: string = 'com.ttrace.prebabellens.sharedimport';
  // shortcut: cap incoming images at 64 MiB; use streamed copying if larger images become a product requirement.
  private static readonly MAX_IMAGE_BYTES: number = 64 * 1024 * 1024;
  private static store?: preferences.Preferences;
  private static context?: common.Context;
  private static directory: string = '';
  private static queue: Promise<void> = Promise.resolve();

  static initialize(context: common.Context): void {
    const directory: string = `${context.filesDir}/${this.SHARED_IMPORTS_DIRECTORY_NAME}`;
    if (this.store) {
      if (directory !== this.directory) {
        throw new Error('Shared import store is already initialized with another sandbox');
      }
      return;
    }
    if (!fileIo.accessSync(directory)) {
      fileIo.mkdirSync(directory, true);
    }
    const stat: fileIo.Stat = fileIo.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Invalid shared import directory');
    }
    this.directory = directory;
    this.context = context;
    const options: preferences.Options = { name: this.PASTEBOARD_NAME };
    this.store = preferences.getPreferencesSync(context, options);
    const pending: PendingPreferences = this.readPending();
    for (const filename of fileIo.listFileSync(directory)) {
      if (filename !== pending.imageRelativePath && this.isOwnedFilename(filename)) {
        this.clearPendingImage(filename);
      }
    }
  }

  static savePendingText(text: string): Promise<void> {
    return this.serialized(async (): Promise<void> => {
      const normalized: string = text.trim();
      if (normalized.length === 0) {
        return;
      }
      const previous: PendingPreferences = this.readPending();
      const next: PendingPreferences = { text: normalized, kind: PendingImportKind.TEXT, imageRelativePath: '' };
      await this.commit(next, previous);
      this.clearPendingImage(previous.imageRelativePath);
    });
  }

  static savePendingImageData(data: ArrayBuffer, fileExtension?: string): Promise<boolean> {
    return this.serialized(async (): Promise<boolean> => {
      if (data.byteLength === 0 || data.byteLength > this.MAX_IMAGE_BYTES) {
        return false;
      }
      let destination: string;
      try {
        destination = this.makeSharedImageURL(fileExtension);
      } catch (error) {
        return false;
      }
      const temporary: string = `${destination}.tmp`;
      const previous: PendingPreferences = this.readPending();
      try {
        const file: fileIo.File = fileIo.openSync(temporary,
          fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        try {
          let written: number = 0;
          while (written < data.byteLength) {
            const count: number = fileIo.writeSync(file.fd, data.slice(written));
            if (count <= 0) {
              throw new Error('Unable to write shared image');
            }
            written += count;
          }
          fileIo.fsyncSync(file.fd);
        } finally {
          fileIo.closeSync(file.fd);
        }
        fileIo.renameSync(temporary, destination);
        const next: PendingPreferences = {
          text: '', kind: PendingImportKind.IMAGE,
          imageRelativePath: destination.substring(this.directory.length + 1)
        };
        await this.commit(next, previous);
      } catch (error) {
        this.clearPendingImage(temporary.substring(this.directory.length + 1));
        this.clearPendingImage(destination.substring(this.directory.length + 1));
        console.warn(`Shared image could not be stored: ${(error as Error).message}`);
        return false;
      }
      this.clearPendingImage(previous.imageRelativePath);
      return true;
    });
  }

  static consumePendingImport(): Promise<PendingImport | undefined> {
    return this.serialized(async (): Promise<PendingImport | undefined> => {
      this.reloadFromDisk();
      const pending: PendingPreferences = this.readPending();
      let result: PendingImport | undefined;
      if (pending.kind === PendingImportKind.IMAGE && this.isOwnedFilename(pending.imageRelativePath) &&
        !pending.imageRelativePath.endsWith('.tmp')) {
        const imageFile: string = `${this.directory}/${pending.imageRelativePath}`;
        try {
          const stat: fileIo.Stat = fileIo.lstatSync(imageFile);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) {
            result = { kind: PendingImportKind.IMAGE, imageFile: imageFile };
          }
        } catch (error) {
          console.warn(`Pending shared image cannot be opened: ${(error as Error).message}`);
        }
      }
      if (!result && pending.text.length > 0) {
        result = { kind: PendingImportKind.TEXT, text: pending.text };
      }
      await this.commit({ text: '', kind: '', imageRelativePath: '' }, pending);
      if (result?.kind !== PendingImportKind.IMAGE) {
        this.clearPendingImage(pending.imageRelativePath);
      }
      return result;
    });
  }

  static consumePendingText(): Promise<string | undefined> {
    return this.serialized(async (): Promise<string | undefined> => {
      this.reloadFromDisk();
      const pending: PendingPreferences = this.readPending();
      if (pending.kind === PendingImportKind.IMAGE) {
        return undefined;
      }
      if (pending.text.length === 0) {
        return undefined;
      }
      await this.commit({ text: '', kind: '', imageRelativePath: '' }, pending);
      this.clearPendingImage(pending.imageRelativePath);
      return pending.text;
    });
  }

  static async intakeWant(want: Want): Promise<boolean> {
    const parameters: Record<string, Object> | undefined = want.parameters;
    const sharedText: Object | undefined = parameters?.['ohos.extra.param.key.TEXT'] ?? parameters?.text;
    if (typeof sharedText === 'string' && sharedText.trim().length > 0) {
      await this.savePendingText(sharedText);
      return true;
    }
    const stream: Object | undefined = parameters?.['ohos.extra.param.key.STREAM'];
    const uri: string = typeof stream === 'string' ? stream : (want.uri ?? '');
    if (!(want.type ?? '').toLowerCase().startsWith('image/') || !this.isTrustedImageURI(uri)) {
      return false;
    }
    const file: fileIo.File = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    try {
      const stat: fileIo.Stat = fileIo.statSync(file.fd);
      if (!stat.isFile() || stat.size <= 0 || stat.size > this.MAX_IMAGE_BYTES) {
        return false;
      }
      const data: ArrayBuffer = new ArrayBuffer(stat.size);
      let read: number = 0;
      while (read < stat.size) {
        const chunk: ArrayBuffer = new ArrayBuffer(stat.size - read);
        const options: ReadOptions = { length: chunk.byteLength };
        const count: number = fileIo.readSync(file.fd, chunk, options);
        if (count <= 0) {
          throw new Error('Unable to read shared image');
        }
        new Uint8Array(data).set(new Uint8Array(chunk, 0, count), read);
        read += count;
      }
      const extension: string = (want.type ?? '').split('/')[1];
      return await this.savePendingImageData(data, extension);
    } finally {
      fileIo.closeSync(file.fd);
    }
  }

  static releaseImageFile(path: string): void {
    const directory: string = this.sharedImportsDirectoryURL();
    if (path.startsWith(`${directory}/`)) {
      this.clearPendingImage(path.substring(directory.length + 1));
    }
  }

  private static isTrustedImageURI(uri: string): boolean {
    try {
      const decoded: string = decodeURIComponent(uri);
      if (decoded.indexOf('\0') >= 0 || decoded.indexOf('\\') >= 0 || decoded.indexOf('%') >= 0 ||
        decoded.split('/').some((part: string) => part === '..' || part === '.') || /[?#]/.test(decoded)) {
        return false;
      }
      return /^file:\/\/(media|docs)\//.test(decoded) || /^datashare:\/\/\/media\//.test(decoded);
    } catch (error) {
      return false;
    }
  }

  private static makeSharedImageURL(fileExtension?: string): string {
    let extension: string = (fileExtension ?? 'jpg').trim().toLowerCase();
    if (extension.length === 0) {
      extension = 'jpg';
    }
    if (!/^(jpg|jpeg|png|gif|bmp|webp|heic|heif|tif|tiff)$/.test(extension)) {
      throw new Error('Unsupported shared image extension');
    }
    return `${this.sharedImportsDirectoryURL()}/${util.generateRandomUUID()}.${extension}`;
  }

  private static sharedImportsDirectoryURL(): string {
    if (!this.store || this.directory.length === 0) {
      throw new Error('Initialize SharedImportStore with an ability context before use');
    }
    return this.directory;
  }

  private static isOwnedFilename(filename: string): boolean {
    return /^[a-fA-F0-9-]{36}\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|tif|tiff)(\.tmp)?$/.test(filename);
  }

  private static clearPendingImage(relativePath: string): void {
    if (!this.isOwnedFilename(relativePath)) {
      return;
    }
    const path: string = `${this.sharedImportsDirectoryURL()}/${relativePath}`;
    try {
      if (fileIo.accessSync(path)) {
        fileIo.unlinkSync(path);
      }
    } catch (error) {
      console.warn(`Shared image cleanup failed: ${(error as Error).message}`);
    }
  }

  // The share extension (ShareExtAbility) saves from its own process; drop this process's cached copy
  // so a pending share is seen when zen-Babel comes back to the foreground.
  private static reloadFromDisk(): void {
    if (this.context === undefined) {
      return;
    }
    const options: preferences.Options = { name: this.PASTEBOARD_NAME };
    preferences.removePreferencesFromCacheSync(this.context, options);
    this.store = preferences.getPreferencesSync(this.context, options);
  }

  private static readPending(): PendingPreferences {
    this.sharedImportsDirectoryURL();
    const store: preferences.Preferences = this.store!;
    const text: preferences.ValueType = store.getSync(this.PENDING_TEXT_KEY, '');
    const kind: preferences.ValueType = store.getSync(this.PENDING_IMPORT_KIND_KEY, '');
    const path: preferences.ValueType = store.getSync(this.PENDING_IMAGE_RELATIVE_PATH_KEY, '');
    return { text: typeof text === 'string' ? text : '', kind: typeof kind === 'string' ? kind : '',
      imageRelativePath: typeof path === 'string' ? path : '' };
  }

  private static writePending(value: PendingPreferences): void {
    const store: preferences.Preferences = this.store!;
    store.putSync(this.PENDING_TEXT_KEY, value.text);
    store.putSync(this.PENDING_IMPORT_KIND_KEY, value.kind);
    store.putSync(this.PENDING_IMAGE_RELATIVE_PATH_KEY, value.imageRelativePath);
    store.deleteSync(this.PENDING_DATE_KEY);
  }

  private static async commit(next: PendingPreferences, previous: PendingPreferences): Promise<void> {
    try {
      this.writePending(next);
      await this.store!.flush();
    } catch (error) {
      this.writePending(previous);
      throw error as Error;
    }
  }

  private static serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result: Promise<T> = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
