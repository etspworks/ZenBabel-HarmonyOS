// NAPI bridge to the NLLB engine (nllb_engine.cpp): load the bundled model, translate a batch of texts; and to
// CLD3 for source language identification.
// Work starts on napi async-work threads and runs on one model thread; ArkTS gets Promises.
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <future>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <hilog/log.h>
#include "napi/native_api.h"

#include "nllb_engine.h"
#include "nnet_language_identifier.h"

namespace {

constexpr unsigned int kLogDomain = 0x0000;
constexpr const char *kLogTag = "nllb";
constexpr int kThreads = 4;  // a phone has 8 cores, the UI keeps the rest

struct LoadedModel {
  NllbEngine engine;
  std::atomic<bool> cancel{false};
};

// MindSpore Lite's runtime crashes when a model is used from more than one thread (napi runs each async work on any
// pool thread), so every model call runs on this one thread, in order.
void postToModelThread(std::function<void()> task) {
  static std::mutex mutex;
  static std::condition_variable ready;
  static std::deque<std::function<void()>> tasks;
  static std::thread worker([] {
    for (;;) {
      std::function<void()> next;
      {
        std::unique_lock<std::mutex> lock(mutex);
        ready.wait(lock, [] { return !tasks.empty(); });
        next = std::move(tasks.front());
        tasks.pop_front();
      }
      next();
    }
  });
  {
    std::lock_guard<std::mutex> lock(mutex);
    tasks.push_back(std::move(task));
  }
  ready.notify_one();
}

void runOnModelThread(const std::function<void()> &task) {
  std::packaged_task<void()> work(task);
  std::future<void> done = work.get_future();
  postToModelThread([&work] { work(); });
  done.get();
}

std::mutex gMutex;
std::map<int64_t, std::shared_ptr<LoadedModel>> gModels;
int64_t gNextHandle = 1;

std::shared_ptr<LoadedModel> modelFor(int64_t handle) {
  std::lock_guard<std::mutex> lock(gMutex);
  auto found = gModels.find(handle);
  return found == gModels.end() ? nullptr : found->second;
}

int64_t handleArg(napi_env env, napi_value value) {
  int64_t handle = 0;
  napi_get_value_int64(env, value, &handle);
  return handle;
}

std::string stringArg(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string text(length, '\0');
  napi_get_value_string_utf8(env, value, &text[0], length + 1, &length);
  return text;
}

napi_value makeError(napi_env env, const std::string &message) {
  napi_value text = nullptr;
  napi_value error = nullptr;
  napi_create_string_utf8(env, message.c_str(), message.size(), &text);
  napi_create_error(env, nullptr, text, &error);
  return error;
}

// ---- loadModel(dir: string): Promise<number> ----
struct LoadWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string dir;
  int64_t handle = 0;
  std::string error;
};

napi_value LoadModel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto *data = new LoadWork();
  data->dir = argc > 0 ? stringArg(env, argv[0]) : "";
  napi_value promise = nullptr;
  napi_create_promise(env, &data->deferred, &promise);
  napi_value name = nullptr;
  napi_create_string_utf8(env, "nllbLoadModel", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(
      env, nullptr, name,
      [](napi_env, void *raw) {
        auto *data = static_cast<LoadWork *>(raw);
        auto model = std::make_shared<LoadedModel>();
        runOnModelThread([&] { data->error = model->engine.load(data->dir, kThreads); });
        if (data->error.empty()) {
          std::lock_guard<std::mutex> lock(gMutex);
          data->handle = gNextHandle++;
          gModels[data->handle] = model;
        }
      },
      [](napi_env env, napi_status, void *raw) {
        auto *data = static_cast<LoadWork *>(raw);
        if (data->error.empty()) {
          napi_value handle = nullptr;
          napi_create_int64(env, data->handle, &handle);
          napi_resolve_deferred(env, data->deferred, handle);
        } else {
          OH_LOG_Print(LOG_APP, LOG_ERROR, kLogDomain, kLogTag, "loadModel failed: %{public}s", data->error.c_str());
          napi_reject_deferred(env, data->deferred, makeError(env, "loadModel failed: " + data->error));
        }
        napi_delete_async_work(env, data->work);
        delete data;
      },
      data, &data->work);
  napi_queue_async_work(env, data->work);
  return promise;
}

// ---- translate(handle: number, texts: string[], source: string, target: string): Promise<string[]> ----
struct TranslateWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::shared_ptr<LoadedModel> model;
  int64_t handle = 0;
  std::vector<std::string> texts;
  std::string source;
  std::string target;
  std::vector<std::string> results;
  std::string error;
};

napi_value Translate(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4] = {nullptr, nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto *data = new TranslateWork();
  if (argc == 4) {
    data->handle = handleArg(env, argv[0]);
    uint32_t count = 0;
    napi_get_array_length(env, argv[1], &count);
    for (uint32_t i = 0; i < count; i++) {
      napi_value item = nullptr;
      napi_get_element(env, argv[1], i, &item);
      data->texts.push_back(stringArg(env, item));
    }
    data->source = stringArg(env, argv[2]);
    data->target = stringArg(env, argv[3]);
  }
  data->model = modelFor(data->handle);
  if (data->model) {
    data->model->cancel = false;  // a new request clears an earlier cancel
  }
  napi_value promise = nullptr;
  napi_create_promise(env, &data->deferred, &promise);
  napi_value name = nullptr;
  napi_create_string_utf8(env, "nllbTranslate", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(
      env, nullptr, name,
      [](napi_env, void *raw) {
        auto *data = static_cast<TranslateWork *>(raw);
        auto &model = data->model;
        if (!model) {
          data->error = "no loaded model for handle " + std::to_string(data->handle);
          return;
        }
        if (!model->engine.hasLanguage(data->source) || !model->engine.hasLanguage(data->target)) {
          data->error = "unsupported language pair " + data->source + " -> " + data->target;
          return;
        }
        try {
          runOnModelThread([&] {
            for (const auto &text : data->texts) {
              auto start = std::chrono::steady_clock::now();
              data->results.push_back(model->engine.translate(text, data->source, data->target, model->cancel));
              long ms = static_cast<long>(
                  std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start)
                      .count());
              OH_LOG_Print(LOG_APP, LOG_INFO, kLogDomain, kLogTag,
                           "translated %{public}zu -> %{public}zu bytes in %{public}ld ms", text.size(),
                           data->results.back().size(), ms);
            }
          });
        } catch (const std::exception &e) {
          data->error = e.what();
        }
      },
      [](napi_env env, napi_status, void *raw) {
        auto *data = static_cast<TranslateWork *>(raw);
        if (data->error.empty()) {
          napi_value array = nullptr;
          napi_create_array_with_length(env, data->results.size(), &array);
          for (size_t i = 0; i < data->results.size(); i++) {
            napi_value text = nullptr;
            napi_create_string_utf8(env, data->results[i].c_str(), data->results[i].size(), &text);
            napi_set_element(env, array, static_cast<uint32_t>(i), text);
          }
          napi_resolve_deferred(env, data->deferred, array);
        } else {
          OH_LOG_Print(LOG_APP, LOG_ERROR, kLogDomain, kLogTag, "translate failed: %{public}s", data->error.c_str());
          napi_reject_deferred(env, data->deferred, makeError(env, "translate failed: " + data->error));
        }
        napi_delete_async_work(env, data->work);
        delete data;
      },
      data, &data->work);
  napi_queue_async_work(env, data->work);
  return promise;
}

// ---- cancel(handle: number): void ----
napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto model = argc > 0 ? modelFor(handleArg(env, argv[0])) : nullptr;
  if (model) {
    model->cancel = true;
  }
  return nullptr;
}

// ---- detectLanguage(text: string): LanguageGuess ----
// CLD3 on the calling (ArkTS) thread: it is quick and its parameters are compiled in, so nothing to load.
napi_value DetectLanguage(napi_env env, napi_callback_info info) {
  static chrome_lang_id::NNetLanguageIdentifier identifier(0, 512);  // looks at the first 512 bytes
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const auto guess = identifier.FindLanguage(argc > 0 ? stringArg(env, argv[0]) : "");
  const bool known = guess.language != chrome_lang_id::NNetLanguageIdentifier::kUnknown;
  napi_value result = nullptr;
  napi_value language = nullptr;
  napi_value probability = nullptr;
  napi_value reliable = nullptr;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, known ? guess.language.c_str() : "und", NAPI_AUTO_LENGTH, &language);
  napi_create_double(env, guess.probability, &probability);
  napi_get_boolean(env, known && guess.is_reliable, &reliable);
  napi_set_named_property(env, result, "language", language);
  napi_set_named_property(env, result, "probability", probability);
  napi_set_named_property(env, result, "reliable", reliable);
  return result;
}

// ---- unloadModel(handle: number): void ----
napi_value UnloadModel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc > 0) {
    std::shared_ptr<LoadedModel> model;
    {
      std::lock_guard<std::mutex> lock(gMutex);
      auto found = gModels.find(handleArg(env, argv[0]));
      if (found != gModels.end()) {
        model = std::move(found->second);
        gModels.erase(found);
      }
    }
    // Freed on the model thread, after any translation still queued for it.
    postToModelThread([model]() mutable { model.reset(); });
  }
  return nullptr;
}

}  // namespace

EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
      {"loadModel", nullptr, LoadModel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"translate", nullptr, Translate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"unloadModel", nullptr, UnloadModel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"detectLanguage", nullptr, DetectLanguage, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}
EXTERN_C_END

static napi_module nllbModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "nllb_napi",
    .nm_priv = nullptr,
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterNllbModule(void) { napi_module_register(&nllbModule); }
