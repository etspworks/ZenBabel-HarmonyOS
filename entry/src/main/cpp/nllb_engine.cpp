#include "nllb_engine.h"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <fstream>
#include <stdexcept>

#include <mindspore/context.h>
#include <mindspore/tensor.h>

namespace {
constexpr int32_t kEos = 2;
constexpr int32_t kUnk = 3;
constexpr int64_t kSlots = 256;  // decoder self-attention cache slots = longest output in tokens
constexpr int32_t kPad = 1;
constexpr int64_t kSourceSlots = 128;                  // the models' fixed source length, padded
constexpr size_t kMaxSourceTokens = kSourceSlots - 2;  // with the language token and </s>; longer is cut in pieces
constexpr float kSkip = -1e4f;                         // masked out; FP16-safe (float32 minimum overflows in FP16)

OH_AI_ModelHandle buildModel(const std::string &path, int threads) {
  OH_AI_ContextHandle context = OH_AI_ContextCreate();
  OH_AI_ContextSetThreadNum(context, threads);
  OH_AI_DeviceInfoHandle cpu = OH_AI_DeviceInfoCreate(OH_AI_DEVICETYPE_CPU);
  // FP16 kernels keep the weights in half precision once loaded: about half the memory of float32, and faster.
  OH_AI_DeviceInfoSetEnableFP16(cpu, true);
  OH_AI_ContextAddDeviceInfo(context, cpu);
  OH_AI_ModelHandle model = OH_AI_ModelCreate();
  // The model owns the context once it is built.
  if (OH_AI_ModelBuildFromFile(model, path.c_str(), OH_AI_MODELTYPE_MINDIR, context) != OH_AI_STATUS_SUCCESS) {
    OH_AI_ModelDestroy(&model);
    OH_AI_ContextDestroy(&context);
    return nullptr;
  }
  return model;
}

OH_AI_TensorHandle inputTensor(OH_AI_ModelHandle model, const char *name) {
  OH_AI_TensorHandle tensor = OH_AI_ModelGetInputByTensorName(model, name);
  if (tensor == nullptr) {
    throw std::runtime_error(std::string("no input ") + name);
  }
  return tensor;
}

OH_AI_TensorHandle outputTensor(OH_AI_ModelHandle model, const char *name) {
  OH_AI_TensorHandle tensor = OH_AI_ModelGetOutputByTensorName(model, name);
  if (tensor == nullptr) {
    throw std::runtime_error(std::string("no output ") + name);
  }
  return tensor;
}

void check(bool ok, const char *what) {
  if (!ok) {
    throw std::runtime_error(std::string("MindSpore Lite: ") + what + " failed");
  }
}

// The tensor's buffer, after checking it holds at least bytes.
void *tensorData(OH_AI_TensorHandle tensor, size_t bytes, const char *name) {
  check(tensor != nullptr && OH_AI_TensorGetDataSize(tensor) >= bytes, name);
  void *data = OH_AI_TensorGetMutableData(tensor);
  check(data != nullptr, name);
  return data;
}

void copyInto(OH_AI_TensorHandle tensor, const void *source, size_t bytes, const char *name) {
  std::memcpy(tensorData(tensor, bytes, name), source, bytes);
}

// Splits after . ! ? followed by a space, and after the CJK full stop, exclamation and question marks.
// Each sentence keeps the whitespace that follows it, so joining the pieces gives the text back.
std::vector<std::string> splitSentences(const std::string &text) {
  static const char *kCjkEnds[] = {"\xE3\x80\x82", "\xEF\xBC\x81", "\xEF\xBC\x9F"};  // 。！？
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i < text.size(); ++i) {
    size_t end = 0;
    char c = text[i];
    if ((c == '.' || c == '!' || c == '?') && i + 1 < text.size() && isspace(static_cast<unsigned char>(text[i + 1]))) {
      end = i + 1;
    } else {
      for (const char *mark : kCjkEnds) {
        if (text.compare(i, 3, mark) == 0) {
          end = i + 3;
        }
      }
    }
    if (end == 0) {
      continue;
    }
    while (end < text.size() && isspace(static_cast<unsigned char>(text[end]))) {
      ++end;
    }
    out.push_back(text.substr(start, end - start));
    start = end;
    i = end - 1;
  }
  if (start < text.size()) {
    out.push_back(text.substr(start));
  }
  return out;
}
// NLLB's SentencePiece normalization turns full-width punctuation into ASCII, so Chinese and Japanese output comes
// back with ',' and '.'. Commas, and full stops, ? and ! at the end or before a space, get their CJK forms; numbers
// (3.5, 1,000) keep theirs.
std::string fullWidthPunctuation(const std::string &text, bool japanese) {
  std::string out;
  for (size_t i = 0; i < text.size(); ++i) {
    const char c = text[i];
    const bool boundary = i + 1 == text.size() || text[i + 1] == ' ';
    const bool betweenDigits = i > 0 && i + 1 < text.size() && isdigit(static_cast<unsigned char>(text[i - 1])) &&
                               isdigit(static_cast<unsigned char>(text[i + 1]));
    if (c == ',' && !betweenDigits) {
      out += japanese ? "\xE3\x80\x81" : "\xEF\xBC\x8C";  // 、 ，
    } else if (c == '.' && boundary) {
      out += "\xE3\x80\x82";  // 。
    } else if (c == '?' && boundary) {
      out += "\xEF\xBC\x9F";  // ？
    } else if (c == '!' && boundary) {
      out += "\xEF\xBC\x81";  // ！
    } else {
      out += c;
    }
  }
  return out;
}
}  // namespace

NllbEngine::~NllbEngine() {
  if (encoder_ != nullptr) {
    OH_AI_ModelDestroy(&encoder_);
  }
  if (decoder_ != nullptr) {
    OH_AI_ModelDestroy(&decoder_);
  }
}

std::string NllbEngine::load(const std::string &dir, int threads) {
  if (!sp_.Load(dir + "/sentencepiece.bpe.model").ok()) {
    return "cannot load " + dir + "/sentencepiece.bpe.model";
  }
  std::ifstream vocab(dir + "/vocab.txt");
  for (std::string piece; std::getline(vocab, piece);) {
    ids_.emplace(piece, static_cast<int32_t>(pieces_.size()));
    pieces_.push_back(piece);
  }
  if (pieces_.empty()) {
    return "cannot load " + dir + "/vocab.txt";
  }
  std::ifstream languages(dir + "/languages.txt");
  for (std::string code; std::getline(languages, code);) {
    auto found = ids_.find(code);
    if (found != ids_.end()) {
      languages_.insert(found->second);
    }
  }
  if (languages_.empty()) {
    return "cannot load " + dir + "/languages.txt";
  }
  encoder_ = buildModel(dir + "/encoder.ms", threads);
  decoder_ = buildModel(dir + "/decoder.ms", threads);
  if (encoder_ == nullptr || decoder_ == nullptr) {
    return "cannot build the MindSpore Lite models in " + dir;
  }
  return "";
}

bool NllbEngine::hasLanguage(const std::string &code) const {
  auto found = ids_.find(code);
  return found != ids_.end() && languages_.count(found->second) > 0;
}

std::string NllbEngine::translate(const std::string &text, const std::string &src, const std::string &tgt,
                                  const std::atomic<bool> &cancel) {
  const int32_t source = ids_.at(src);
  const int32_t target = ids_.at(tgt);
  // Chinese and Japanese put no space between sentences, and get full-width punctuation back.
  const bool chinese = tgt.rfind("zho_", 0) == 0;
  const bool japanese = tgt.rfind("jpn_", 0) == 0;
  const std::string gap = chinese || japanese ? "" : " ";
  std::string out;
  for (const std::string &sentence : splitSentences(text)) {
    size_t last = sentence.find_last_not_of(" \t\r\n");
    if (last == std::string::npos) {
      out += sentence;
      continue;
    }
    std::vector<std::string> pieces;
    sp_.Encode(sentence.substr(0, last + 1), &pieces);
    for (size_t at = 0; at < pieces.size() && !cancel; at += kMaxSourceTokens) {
      std::vector<int32_t> input{source};
      for (size_t i = at; i < std::min(pieces.size(), at + kMaxSourceTokens); ++i) {
        auto found = ids_.find(pieces[i]);
        input.push_back(found == ids_.end() ? kUnk : found->second);
      }
      input.push_back(kEos);
      std::string translated = decode(translateTokens(input, target, cancel));
      if (chinese || japanese) {
        translated = fullWidthPunctuation(translated, japanese);
      }
      if (!out.empty() && !translated.empty() && out.back() != ' ' && out.back() != '\n') {
        out += gap;
      }
      out += translated;
    }
    if (cancel) {
      break;
    }
    // Keep the line breaks between sentences; spaces are added above as the target language needs them.
    size_t breaks = std::count(sentence.begin() + last + 1, sentence.end(), '\n');
    out.append(breaks, '\n');
  }
  return out;
}

std::vector<int32_t> NllbEngine::translateTokens(const std::vector<int32_t> &input, int32_t target,
                                                 const std::atomic<bool> &cancel) {
  const int64_t s = static_cast<int64_t>(input.size());
  // Every shape is fixed (tools/nllb/export_onnx.py): the source is padded to kSourceSlots and masked.
  std::vector<int32_t> ids(kSourceSlots, kPad);
  std::vector<int32_t> attention(kSourceSlots, 0);
  std::vector<float> crossMask(kSourceSlots, kSkip);
  for (size_t i = 0; i < input.size(); ++i) {
    ids[i] = input[i];
    attention[i] = 1;
    crossMask[i] = 0.0f;
  }
  OH_AI_TensorHandleArray encoderInputs = OH_AI_ModelGetInputs(encoder_);
  copyInto(inputTensor(encoder_, "input_ids"), ids.data(), ids.size() * sizeof(int32_t), "input_ids");
  copyInto(inputTensor(encoder_, "attention_mask"), attention.data(), attention.size() * sizeof(int32_t),
           "attention_mask");
  OH_AI_TensorHandleArray encoderOutputs;
  check(OH_AI_ModelPredict(encoder_, encoderInputs, &encoderOutputs, nullptr, nullptr) == OH_AI_STATUS_SUCCESS,
        "encoder predict");
  OH_AI_TensorHandle cross = encoderOutputs.handle_list[0];
  check(OH_AI_TensorGetDataType(cross) == OH_AI_DATATYPE_NUMBERTYPE_FLOAT32, "cross_kv is not float32");
  size_t crossRank = 0;
  const int64_t *crossDims = OH_AI_TensorGetShape(cross, &crossRank);
  check(crossRank == 5, "cross_kv rank");
  const int64_t layers2 = crossDims[0], heads = crossDims[2], headDim = crossDims[4];

  OH_AI_TensorHandleArray decoderInputs = OH_AI_ModelGetInputs(decoder_);
  const size_t cacheFloats = static_cast<size_t>(layers2 * heads * kSlots * headDim);
  auto *token = static_cast<int32_t *>(tensorData(inputTensor(decoder_, "token"), sizeof(int32_t), "token"));
  auto *step = static_cast<int32_t *>(tensorData(inputTensor(decoder_, "step"), sizeof(int32_t), "step"));
  auto *selfKv =
      static_cast<float *>(tensorData(inputTensor(decoder_, "self_kv"), cacheFloats * sizeof(float), "self_kv"));
  auto *mask =
      static_cast<float *>(tensorData(inputTensor(decoder_, "self_mask"), (kSlots + 1) * sizeof(float), "self_mask"));
  copyInto(inputTensor(decoder_, "cross_kv"), OH_AI_TensorGetData(cross), OH_AI_TensorGetDataSize(cross), "cross_kv");
  copyInto(inputTensor(decoder_, "cross_mask"), crossMask.data(), crossMask.size() * sizeof(float), "cross_mask");
  std::fill(selfKv, selfKv + layers2 * heads * kSlots * headDim, 0.0f);
  std::fill(mask, mask + kSlots, kSkip);
  mask[kSlots] = 0.0f;

  std::vector<int32_t> out;
  token[0] = kEos;
  const int64_t limit = std::min<int64_t>(kSlots, 2 * s + 10);
  for (int64_t i = 0; i < limit && !cancel; ++i) {
    step[0] = static_cast<int32_t>(i);
    OH_AI_TensorHandleArray outputs;
    check(OH_AI_ModelPredict(decoder_, decoderInputs, &outputs, nullptr, nullptr) == OH_AI_STATUS_SUCCESS,
          "decoder predict");
    // Copy this step's keys and values into cache slot i of every layer and head.
    OH_AI_TensorHandle freshKv = outputTensor(decoder_, "new_kv");
    check(OH_AI_TensorGetDataSize(freshKv) >= static_cast<size_t>(layers2 * heads * headDim) * sizeof(float),
          "new_kv size");
    const auto *fresh = static_cast<const float *>(OH_AI_TensorGetData(freshKv));
    for (int64_t row = 0; row < layers2 * heads; ++row) {
      std::memcpy(selfKv + (row * kSlots + i) * headDim, fresh + row * headDim, headDim * sizeof(float));
    }
    mask[i] = 0.0f;
    // The first step only fills the cache for the start token; the target language token is forced.
    int32_t next =
        i == 0 ? target : static_cast<const int32_t *>(OH_AI_TensorGetData(outputTensor(decoder_, "next_token")))[0];
    if (next == kEos) {
      break;
    }
    out.push_back(next);
    token[0] = next;
  }
  return out;
}

std::string NllbEngine::decode(const std::vector<int32_t> &ids) const {
  std::string text;
  for (int32_t id : ids) {
    if (id > kUnk && languages_.count(id) == 0) {
      text += pieces_[id];
    }
  }
  // SentencePiece marks word starts with U+2581.
  std::string out;
  for (size_t i = 0; i < text.size(); ++i) {
    if (text.compare(i, 3, "\xE2\x96\x81") == 0) {
      if (!out.empty()) {
        out += ' ';
      }
      i += 2;
    } else {
      out += text[i];
    }
  }
  return out;
}
