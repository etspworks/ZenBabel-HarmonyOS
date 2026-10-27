#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <mindspore/model.h>
#include <sentencepiece_processor.h>

// NLLB-200-distilled-600M on MindSpore Lite: encoder.ms and decoder.ms from tools/nllb/export_onnx.py,
// sentencepiece.bpe.model, vocab.txt (one piece per line, line number = token id) and languages.txt (the language
// tokens, such as eng_Latn, that src and tgt name).
class NllbEngine {
 public:
  ~NllbEngine();
  // Returns an empty string on success, otherwise what failed.
  std::string load(const std::string &dir, int threads);
  bool hasLanguage(const std::string &code) const;
  // Translates one text (it is split into sentences here). Stops early, returning what it has, once cancel is set.
  // Throws std::runtime_error when MindSpore Lite fails.
  std::string translate(const std::string &text, const std::string &src, const std::string &tgt,
                        const std::atomic<bool> &cancel);

 private:
  std::vector<int32_t> translateTokens(const std::vector<int32_t> &input, int32_t target,
                                       const std::atomic<bool> &cancel);
  std::string decode(const std::vector<int32_t> &ids) const;

  OH_AI_ModelHandle encoder_ = nullptr;
  OH_AI_ModelHandle decoder_ = nullptr;
  sentencepiece::SentencePieceProcessor sp_;
  std::vector<std::string> pieces_;
  std::unordered_map<std::string, int32_t> ids_;
  std::unordered_set<int32_t> languages_;  // ids of the language tokens
};
