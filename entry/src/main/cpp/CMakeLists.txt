cmake_minimum_required(VERSION 3.16)
project(zenbabel_nllb)

# SentencePiece tokenizes text for NLLB. CMake downloads the pinned release on the first configure.
include(FetchContent)
FetchContent_Declare(sentencepiece
  URL https://github.com/google/sentencepiece/archive/refs/tags/v0.2.0.tar.gz
  URL_HASH SHA256=9970f0a0afee1648890293321665e5b2efa04eaec9f1671fcf8048f456f5bb86)
set(SPM_ENABLE_SHARED OFF CACHE BOOL "" FORCE)
set(SPM_ENABLE_TCMALLOC OFF CACHE BOOL "" FORCE)
FetchContent_GetProperties(sentencepiece)
if(NOT sentencepiece_POPULATED)
  FetchContent_Populate(sentencepiece)
  add_subdirectory(${sentencepiece_SOURCE_DIR} ${sentencepiece_BINARY_DIR} EXCLUDE_FROM_ALL)
endif()

# CLD3 (Google's Compact Language Detector v3) identifies the source language. It runs on the protobuf-lite 3.14.0
# that SentencePiece builds; cld3/cld_3/protos holds its .proto files compiled once with protoc 3.14.0
# (protoc --cpp_out=<dir>/cld_3/protos feature_extractor.proto sentence.proto task_spec.proto, in CLD3's src/).
FetchContent_Declare(cld3
  URL https://github.com/google/cld3/archive/b48dc46512566f5a2d41118c8c1116c4f96dc661.tar.gz
  URL_HASH SHA256=d0d4ea2fddcbc7d10ace2c37309feb09da87e8ce7ced6ce73592da1359f4765f)
FetchContent_GetProperties(cld3)
if(NOT cld3_POPULATED)
  FetchContent_Populate(cld3)
endif()
file(GLOB CLD3_SOURCES ${cld3_SOURCE_DIR}/src/*.cc ${cld3_SOURCE_DIR}/src/script_span/*.cc
  ${CMAKE_CURRENT_SOURCE_DIR}/cld3/cld_3/protos/*.cc)
list(FILTER CLD3_SOURCES EXCLUDE REGEX "(_test|_main|test_data)\\.cc$|generated_ulscript\\.cc$")

add_library(nllb_napi SHARED napi_init.cpp nllb_engine.cpp ${CLD3_SOURCES})
target_compile_features(nllb_napi PRIVATE cxx_std_17)
target_include_directories(nllb_napi PRIVATE ${sentencepiece_SOURCE_DIR}/src
  ${sentencepiece_SOURCE_DIR}/third_party/protobuf-lite ${cld3_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/cld3)
target_link_libraries(nllb_napi PRIVATE sentencepiece-static libmindspore_lite_ndk.so libace_napi.z.so libhilog_ndk.z.so)
