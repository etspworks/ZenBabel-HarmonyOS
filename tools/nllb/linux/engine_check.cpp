// Translates "src<TAB>tgt<TAB>text" lines from stdin with the app's engine (nllb_engine.cpp) on Linux.
#include <iostream>
#include "nllb_engine.h"

int main(int argc, char **argv) {
  NllbEngine engine;
  std::string error = engine.load(argv[1], 4);
  if (!error.empty()) {
    std::cerr << error << std::endl;
    return 1;
  }
  std::atomic<bool> cancel{false};
  for (std::string line; std::getline(std::cin, line);) {
    size_t a = line.find('\t'), b = line.find('\t', a + 1);
    std::cout << engine.translate(line.substr(b + 1), line.substr(0, a), line.substr(a + 1, b - a - 1), cancel)
              << std::endl;
  }
  return 0;
}
