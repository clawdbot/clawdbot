#ifndef OPENCLAW_MEDIA_TESTS_TEST_HARNESS_H_
#define OPENCLAW_MEDIA_TESTS_TEST_HARNESS_H_

#include <cstdio>
#include <functional>
#include <string>
#include <type_traits>
#include <vector>

// A three-function test harness. GoogleTest would pull a second dependency into
// an NDK build that already carries one; these tests need registration,
// assertion and a failure line, and nothing else.
namespace openclaw::media::test {

struct TestCase {
  std::string name;
  std::function<void()> body;
};

std::vector<TestCase>& registry();
void fail(const char* file, int line, const std::string& message);
int runAll();

template <typename T>
std::string describe(const T& value) {
  if constexpr (std::is_pointer_v<T>) {
    return value == nullptr ? std::string("nullptr") : std::string("<pointer>");
  } else if constexpr (std::is_enum_v<T>) {
    return std::to_string(static_cast<long long>(value));
  } else if constexpr (std::is_arithmetic_v<T>) {
    return std::to_string(value);
  } else {
    return std::string("<value>");
  }
}

struct Registrar {
  Registrar(const char* name, std::function<void()> body) {
    registry().push_back(TestCase{name, std::move(body)});
  }
};

}  // namespace openclaw::media::test

#define OPENCLAW_TEST(name)                                                     \
  static void name();                                                           \
  static ::openclaw::media::test::Registrar registrar_##name(#name, name);      \
  static void name()

#define EXPECT_TRUE(condition)                                                  \
  do {                                                                          \
    if (!(condition)) {                                                         \
      ::openclaw::media::test::fail(__FILE__, __LINE__, "expected " #condition); \
    }                                                                           \
  } while (0)

#define OPENCLAW_EXPECT_CMP(actual, expected, op, opText)                       \
  do {                                                                          \
    const auto actualValue = (actual);                                          \
    const auto expectedValue = (expected);                                      \
    if (!(actualValue op expectedValue)) {                                      \
      ::openclaw::media::test::fail(                                            \
          __FILE__, __LINE__,                                                   \
          std::string(#actual " " opText " " #expected " (actual ") +           \
              ::openclaw::media::test::describe(actualValue) + ", expected " +  \
              ::openclaw::media::test::describe(expectedValue) + ")");          \
    }                                                                           \
  } while (0)

#define EXPECT_EQ(actual, expected) OPENCLAW_EXPECT_CMP(actual, expected, ==, "==")
#define EXPECT_GE(actual, expected) OPENCLAW_EXPECT_CMP(actual, expected, >=, ">=")
#define EXPECT_LE(actual, expected) OPENCLAW_EXPECT_CMP(actual, expected, <=, "<=")

#endif  // OPENCLAW_MEDIA_TESTS_TEST_HARNESS_H_
