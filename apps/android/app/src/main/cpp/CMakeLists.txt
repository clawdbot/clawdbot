cmake_minimum_required(VERSION 3.22.1)
# ASM is needed for the 32-bit ARM signal-processing translation units that
# upstream ships as hand-written assembly.
project(openclaw_media CXX C ASM)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include("${CMAKE_CURRENT_SOURCE_DIR}/third_party/webrtc-apm.cmake")

# The device-independent engine. It has no Oboe, JNI or Android dependency, so
# the same objects that ship in the app are what the host tests exercise.
add_library(
  openclaw_media_core STATIC
  media/acoustic_processor.cc
  media/capture_uplink.cc
  media/media_telemetry.cc
  media/realtime_media_core.cc
  media/render_timeline.cc)
target_include_directories(openclaw_media_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(openclaw_media_core PUBLIC webrtc_apm)
target_compile_options(openclaw_media_core PRIVATE -Wall -Wextra -Werror -O2)

if(ANDROID)
  find_package(oboe REQUIRED CONFIG)

  add_library(
    openclaw_media SHARED
    android/oboe_device_io.cc
    android/jni_realtime_media_engine.cc)
  target_link_libraries(openclaw_media PRIVATE openclaw_media_core oboe::oboe log)
  target_compile_options(openclaw_media PRIVATE -Wall -Wextra -Werror -O2)
  # 16 KB page-size compatibility: Android 15+ devices may use 16 KB pages, and
  # a library whose load segments are 4 KB-aligned will not map there.
  target_link_options(openclaw_media PRIVATE "-Wl,-z,max-page-size=16384")
else()
  enable_testing()
  add_executable(openclaw_media_tests
                 tests/media_contract_tests.cc
                 tests/synthetic_aec_tests.cc
                 tests/test_main.cc)
  target_link_libraries(openclaw_media_tests PRIVATE openclaw_media_core)
  target_compile_options(openclaw_media_tests PRIVATE -Wall -Wextra -Werror -O2)
  add_test(NAME openclaw_media_tests COMMAND openclaw_media_tests)
endif()
