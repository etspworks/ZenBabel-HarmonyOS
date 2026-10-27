#!/usr/bin/env bash
# Builds the NLLB-200-distilled-600M model files the app bundles (encoder.ms, decoder.ms, sentencepiece.bpe.model,
# vocab.txt, languages.txt) from facebook/nllb-200-distilled-600M. Maintainers run this once per model change and upload the result to Hugging Face;
# app builds download it from there (see entry/hvigorfile.ts). Needs only Docker.
#
#   tools/nllb/convert.sh [work dir, default ~/zenbabel-nllb]
#
# Steps, all in the zenbabel-mt image (tools/nllb/Dockerfile):
#   1. export_onnx.py exports the encoder and the fixed-shape decoder step to ONNX.
#   2. check_onnx.py checks the ONNX graphs translate cases.tsv exactly like Hugging Face's generate().
#   3. converter_lite (MindSpore Lite 2.7.0) converts both to .ms with 8-bit weights.
#   4. linux/engine_check builds the app's own engine source (entry/src/main/cpp/nllb_engine.cpp) against the
#      Linux MindSpore Lite runtime and translates cases.tsv with the converted files.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="${1:-$HOME/zenbabel-nllb}"
spm=sentencepiece-0.2.0
mkdir -p "$work"

docker build --platform linux/amd64 -t zenbabel-mt "$here"
if [ ! -d "$work/$spm" ]; then
  curl -sL -o "$work/spm.tgz" https://github.com/google/sentencepiece/archive/refs/tags/v0.2.0.tar.gz
  echo "9970f0a0afee1648890293321665e5b2efa04eaec9f1671fcf8048f456f5bb86  $work/spm.tgz" | shasum -a 256 -c -
  tar xzf "$work/spm.tgz" -C "$work"
fi

docker run --rm --platform linux/amd64 -v "$work":/w -v "$repo":/r -e HF_HOME=/w/hf zenbabel-mt bash -euc "
  python /r/tools/nllb/export_onnx.py /w/onnx
  python /r/tools/nllb/check_onnx.py /w/onnx /r/tools/nllb/cases.tsv
  mkdir -p /w/ms
  printf '[common_quant_param]\nquant_type=WEIGHT_QUANT\nbit_num=8\nmin_quant_weight_size=0\nmin_quant_weight_channel=16\n' > /w/quant.cfg
  cd /opt/mslite/tools/converter/converter
  for m in encoder decoder; do
    ./converter_lite --fmk=ONNX --modelFile=/w/onnx/\$m.onnx --outputFile=/w/ms/\$m --configFile=/w/quant.cfg | tail -1
  done
  cp /w/onnx/vocab.txt /w/onnx/languages.txt /w/onnx/sentencepiece.bpe.model /w/ms/
  cmake -S /r/tools/nllb/linux -B /w/build -DSPM_DIR=/w/$spm -DAPP_CPP=/r/entry/src/main/cpp -DMSLITE=/opt/mslite \
    -DCMAKE_BUILD_TYPE=Release > /dev/null
  cmake --build /w/build -j8 > /dev/null
  /w/build/engine_check /w/ms < /r/tools/nllb/cases.tsv
  cd /w/ms && sha256sum encoder.ms decoder.ms sentencepiece.bpe.model vocab.txt languages.txt > SHA256SUMS
"
echo "Model files: $work/ms"
