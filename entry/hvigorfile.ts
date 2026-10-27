import { hapTasks } from '@ohos/hvigor-ohos-plugin';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

// The bundled translation model: NLLB-200 distilled 600M for MindSpore Lite, made by tools/nllb/convert.sh and hosted
// on Hugging Face. The first build downloads it into resources/resfile/nllb (about 910 MB); later builds find it
// there. Pinned to one revision of the repository, every file checked against its SHA-256.
const MODEL_URL: string = 'https://huggingface.co/etspworks/nllb-200-distilled-600m-mindspore-lite/resolve/ec035e1b6da6ec27d34d3bf65e6ed6a3edd51085';
const MODEL_FILES: Record<string, string> = {
  'encoder.ms': '01bdd7b50f54516c3c5baeff3b40b46a34ed1f0b95fc39a471f84e03732f65a8',
  'decoder.ms': '25834c6064f37720a5548783c4d0507735b8172b538b445aa4fe605e8b18f379',
  'sentencepiece.bpe.model': '14bb8dfb35c0ffdea7bc01e56cea38b9e3d5efcdcb9c251d6b40538e1aab555a',
  'vocab.txt': 'dc1bb62be232e14a4df889ccc7e50c4c613c364194212b7099e625311a026cce',
  'languages.txt': '35ea95db8ebda6c2873110d16372f3668a743deaec467bf2b62e494106f90676'
};

function download(url: string, file: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    https.get(url, (response) => {
      const status: number = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location !== undefined) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), file).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status} for ${url}`));
        return;
      }
      const out: fs.WriteStream = fs.createWriteStream(file);
      response.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      response.on('error', reject);
    }).on('error', reject);
  });
}

function sha256(file: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash: crypto.Hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

const nllbModel = {
  pluginId: 'nllbModel',
  async apply(): Promise<void> {
    const dir: string = path.resolve(__dirname, 'src/main/resources/resfile/nllb');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, expected] of Object.entries(MODEL_FILES)) {
      const file: string = path.join(dir, name);
      if (fs.existsSync(file)) {
        continue;
      }
      console.log(`Downloading the translation model: ${name}`);
      const part: string = `${file}.part`;
      try {
        await download(`${MODEL_URL}/${name}`, part);
        const actual: string = await sha256(part);
        if (actual !== expected) {
          throw new Error(`SHA-256 mismatch: expected ${expected}, got ${actual}`);
        }
        fs.renameSync(part, file);
      } catch (error) {
        fs.rmSync(part, { force: true });
        throw new Error(`Could not download the translation model file ${name} from ${MODEL_URL}: ` +
          `${(error as Error).message}. Check the network connection and build again.`);
      }
    }
  }
};

export default {
  system: hapTasks, /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: [nllbModel] /* Custom plugin to extend the functionality of Hvigor. */
}
