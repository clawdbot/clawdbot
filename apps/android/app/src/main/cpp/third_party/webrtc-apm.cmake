# WebRTC AudioProcessing (AEC3) as a CMake target.
#
# Upstream ships a Meson build only, so this file is a direct port of its build
# contract: the same source lists, the same per-architecture defines, the same
# optimised translation units. `webrtc-apm-sources.cmake` is generated from the
# upstream `meson.build` files (see the header in that file) so the lists cannot
# drift by hand-transcription.
#
# The archives are fetched by URL and verified by SHA-256 instead of being
# vendored: the APM subset is 730 files, and a committed copy would bury the
# reviewable diff. The abseil hash below is the one upstream itself pins in
# `subprojects/abseil-cpp.wrap`, so the two provenance records cross-check.
#
# Provenance:
#   webrtc-audio-processing 2.1 (2025-01-22), BSD-3-Clause,
#     https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing
#   abseil-cpp 20240722.0, Apache-2.0, https://github.com/abseil/abseil-cpp

include(FetchContent)

set(WEBRTC_APM_VERSION "2.1")
set(WEBRTC_APM_URL
    "https://freedesktop.org/software/pulseaudio/webrtc-audio-processing/webrtc-audio-processing-${WEBRTC_APM_VERSION}.tar.gz")
set(WEBRTC_APM_SHA256 "35e86b986d02ea15f3d04741a1a5a735ba399bc0fac0ee089c39480e35fc3253")

set(ABSEIL_VERSION "20240722.0")
set(ABSEIL_URL "https://github.com/abseil/abseil-cpp/releases/download/${ABSEIL_VERSION}/abseil-cpp-${ABSEIL_VERSION}.tar.gz")
set(ABSEIL_SHA256 "f50e5ac311a81382da7fa75b97310e4b9006474f9560ac46f54a9967f07d4ae3")

# The APM only uses absl base/strings/meta/functional/algorithm headers, so the
# rest of abseil is never configured into a target. Testing off keeps GoogleTest
# out of the dependency graph entirely.
set(ABSL_PROPAGATE_CXX_STD ON CACHE BOOL "" FORCE)
set(ABSL_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(ABSL_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(ABSL_USE_EXTERNAL_GOOGLETEST OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
  abseil
  URL "${ABSEIL_URL}"
  URL_HASH "SHA256=${ABSEIL_SHA256}")

FetchContent_Declare(
  webrtc_apm
  URL "${WEBRTC_APM_URL}"
  URL_HASH "SHA256=${WEBRTC_APM_SHA256}")

FetchContent_MakeAvailable(abseil)
FetchContent_Populate(webrtc_apm)

set(WAP_ROOT "${webrtc_apm_SOURCE_DIR}")
include("${CMAKE_CURRENT_LIST_DIR}/webrtc-apm-sources.cmake")

# Architecture selection mirrors upstream `meson.build`: the generic C
# translation units are replaced, not supplemented, by their assembly
# counterparts, or the linker sees two definitions of the same symbol.
set(_wap_defines
    WEBRTC_LIBRARY_IMPL
    WEBRTC_ENABLE_SYMBOL_EXPORT
    WEBRTC_POSIX
    WEBRTC_APM_DEBUG_DUMP=0
    NDEBUG)
set(_wap_arch_sources "")
set(_wap_arch_libs "")
set(_wap_pffft_simd ON)

if(ANDROID)
  list(APPEND _wap_defines WEBRTC_ANDROID WEBRTC_LINUX)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  list(APPEND _wap_defines WEBRTC_LINUX)
elseif(APPLE)
  list(APPEND _wap_defines WEBRTC_MAC)
endif()

if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64|ARM64)$")
  list(APPEND _wap_defines WEBRTC_ARCH_ARM64 WEBRTC_HAS_NEON)
  list(APPEND _wap_arch_sources
       webrtc/common_audio/fir_filter_neon.cc
       webrtc/common_audio/resampler/sinc_resampler_neon.cc
       webrtc/common_audio/signal_processing/cross_correlation_neon.c
       webrtc/common_audio/signal_processing/downsample_fast_neon.c
       webrtc/common_audio/signal_processing/min_max_operations_neon.c
       webrtc/common_audio/third_party/ooura/fft_size_128/ooura_fft_neon.cc
       webrtc/modules/audio_processing/aecm/aecm_core_c.cc
       webrtc/modules/audio_processing/aecm/aecm_core_neon.cc)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm|armv7|armv7-a)$")
  list(APPEND _wap_defines WEBRTC_ARCH_ARM WEBRTC_ARCH_ARM_V7 WEBRTC_HAS_NEON)
  list(REMOVE_ITEM WAP_COMMON_AUDIO_SOURCES
       webrtc/common_audio/signal_processing/complex_bit_reverse.c
       webrtc/common_audio/signal_processing/filter_ar_fast_q12.c
       webrtc/common_audio/third_party/spl_sqrt_floor/spl_sqrt_floor.c)
  list(APPEND _wap_arch_sources
       webrtc/common_audio/signal_processing/complex_bit_reverse_arm.S
       webrtc/common_audio/signal_processing/filter_ar_fast_q12_armv7.S
       webrtc/common_audio/third_party/spl_sqrt_floor/spl_sqrt_floor_arm.S
       webrtc/common_audio/fir_filter_neon.cc
       webrtc/common_audio/resampler/sinc_resampler_neon.cc
       webrtc/common_audio/signal_processing/cross_correlation_neon.c
       webrtc/common_audio/signal_processing/downsample_fast_neon.c
       webrtc/common_audio/signal_processing/min_max_operations_neon.c
       webrtc/common_audio/third_party/ooura/fft_size_128/ooura_fft_neon.cc
       webrtc/modules/audio_processing/aecm/aecm_core_c.cc
       webrtc/modules/audio_processing/aecm/aecm_core_neon.cc)
else()
  # x86/x86_64. Upstream compiles the AVX2 translation units unconditionally and
  # dispatches on them at runtime, so they live in their own target with the
  # AVX flags that must not reach the dispatcher itself.
  list(APPEND _wap_defines WEBRTC_ENABLE_AVX2)
  list(APPEND _wap_arch_sources webrtc/modules/audio_processing/aecm/aecm_core_c.cc)

  add_library(
    webrtc_apm_sse2 STATIC
    "${WAP_ROOT}/webrtc/common_audio/fir_filter_sse.cc"
    "${WAP_ROOT}/webrtc/common_audio/resampler/sinc_resampler_sse.cc"
    "${WAP_ROOT}/webrtc/common_audio/third_party/ooura/fft_size_128/ooura_fft_sse2.cc")
  add_library(
    webrtc_apm_avx2 STATIC
    "${WAP_ROOT}/webrtc/common_audio/fir_filter_avx2.cc"
    "${WAP_ROOT}/webrtc/common_audio/resampler/sinc_resampler_avx2.cc"
    "${WAP_ROOT}/webrtc/modules/audio_processing/aec3/adaptive_fir_filter_avx2.cc"
    "${WAP_ROOT}/webrtc/modules/audio_processing/aec3/adaptive_fir_filter_erl_avx2.cc"
    "${WAP_ROOT}/webrtc/modules/audio_processing/aec3/fft_data_avx2.cc"
    "${WAP_ROOT}/webrtc/modules/audio_processing/aec3/matched_filter_avx2.cc"
    "${WAP_ROOT}/webrtc/modules/audio_processing/aec3/vector_math_avx2.cc"
    "${WAP_ROOT}/webrtc/modules/audio_processing/agc2/rnn_vad/vector_math_avx2.cc")
  foreach(_arch_lib webrtc_apm_sse2 webrtc_apm_avx2)
    target_include_directories(${_arch_lib} PRIVATE "${WAP_ROOT}/webrtc")
    target_compile_definitions(${_arch_lib} PRIVATE ${_wap_defines})
    target_link_libraries(${_arch_lib} PRIVATE absl::base absl::strings absl::any_invocable)
    set_target_properties(${_arch_lib} PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_STANDARD 17)
  endforeach()
  target_compile_options(webrtc_apm_sse2 PRIVATE -msse2)
  target_compile_options(webrtc_apm_avx2 PRIVATE -mavx2 -mfma)
  set(_wap_arch_libs webrtc_apm_sse2 webrtc_apm_avx2)
endif()

set(_wap_all_sources
    ${WAP_API_SOURCES}
    ${WAP_SYSTEM_WRAPPERS_SOURCES}
    ${WAP_BASE_SOURCES}
    ${WAP_COMMON_AUDIO_SOURCES}
    ${WAP_ISAC_VAD_SOURCES}
    ${WAP_APM_SOURCES}
    ${_wap_arch_sources}
    webrtc/modules/third_party/fft/fft.c
    webrtc/third_party/pffft/src/pffft.c
    webrtc/third_party/rnnoise/src/rnn_vad_weights.cc)
if(ANDROID)
  list(APPEND _wap_all_sources webrtc/rtc_base/system/warn_current_thread_is_deadlocked.cc)
endif()

list(TRANSFORM _wap_all_sources PREPEND "${WAP_ROOT}/")
add_library(webrtc_apm STATIC ${_wap_all_sources})

target_include_directories(webrtc_apm SYSTEM PUBLIC "${WAP_ROOT}/webrtc")
target_compile_definitions(webrtc_apm PUBLIC ${_wap_defines})
set(_wap_pffft_defines _GNU_SOURCE)
if(NOT _wap_pffft_simd)
  list(APPEND _wap_pffft_defines PFFFT_SIMD_DISABLE)
endif()
set_source_files_properties("${WAP_ROOT}/webrtc/third_party/pffft/src/pffft.c"
                            PROPERTIES COMPILE_DEFINITIONS "${_wap_pffft_defines}")
set_target_properties(webrtc_apm PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_STANDARD 17 C_STANDARD 11)
target_link_libraries(
  webrtc_apm
  PUBLIC absl::base absl::strings absl::any_invocable absl::algorithm_container absl::type_traits
  PRIVATE ${_wap_arch_libs})
# Upstream builds at -O2 with warnings on; the port keeps the optimisation level
# and silences third-party warnings so they cannot mask ours.
target_compile_options(webrtc_apm PRIVATE -w -O2)
if(_wap_arch_libs)
  foreach(_arch_lib ${_wap_arch_libs})
    target_compile_options(${_arch_lib} PRIVATE -w -O2)
  endforeach()
endif()
if(ANDROID)
  target_link_libraries(webrtc_apm PUBLIC log)
endif()
