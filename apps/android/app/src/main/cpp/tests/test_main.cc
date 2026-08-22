#include "tests/test_harness.h"

#include <cstdio>

namespace openclaw::media::test {
namespace {
bool currentFailed = false;
int failures = 0;
}  // namespace

std::vector<TestCase>& registry() {
  static std::vector<TestCase> cases;
  return cases;
}

void fail(const char* file, int line, const std::string& message) {
  currentFailed = true;
  std::printf("    %s:%d: %s\n", file, line, message.c_str());
}

int runAll() {
  int passed = 0;
  for (const TestCase& testCase : registry()) {
    currentFailed = false;
    std::printf("[ RUN  ] %s\n", testCase.name.c_str());
    testCase.body();
    if (currentFailed) {
      ++failures;
      std::printf("[ FAIL ] %s\n", testCase.name.c_str());
    } else {
      ++passed;
      std::printf("[  OK  ] %s\n", testCase.name.c_str());
    }
  }
  std::printf("\n%d passed, %d failed, %zu total\n", passed, failures, registry().size());
  return failures == 0 ? 0 : 1;
}

}  // namespace openclaw::media::test

int main() { return openclaw::media::test::runAll(); }
