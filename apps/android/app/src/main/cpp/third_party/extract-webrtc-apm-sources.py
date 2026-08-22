#!/usr/bin/env python3
"""Regenerate `webrtc-apm-sources.cmake` from an extracted upstream tarball.

Upstream webrtc-audio-processing ships a Meson build only. Hand-copying its
source lists into CMake is how a port silently drifts a version later, so the
lists are generated instead. Only the unconditional `name = [...]` assignments
are read; every architecture-conditional `+=` addition is expressed in
`webrtc-apm.cmake` beside the defines that select it.

Usage:
  python3 extract-webrtc-apm-sources.py /path/to/webrtc-audio-processing-2.1 \
      > webrtc-apm-sources.cmake
"""

from __future__ import annotations

import pathlib
import re
import sys

HEADER = """# Generated from webrtc-audio-processing {version} `meson.build` source lists.
#
# Regenerate after a version bump with:
#   python3 apps/android/app/src/main/cpp/third_party/extract-webrtc-apm-sources.py <extracted-tarball-root>
#
# Architecture-conditional translation units are NOT in this file; they live in
# `webrtc-apm.cmake` next to the defines that select them.
"""

LISTS = (
    ("WAP_API_SOURCES", "webrtc/api/meson.build", "api_sources", "webrtc/api/"),
    (
        "WAP_SYSTEM_WRAPPERS_SOURCES",
        "webrtc/system_wrappers/meson.build",
        "system_wrappers_sources",
        "webrtc/system_wrappers/",
    ),
    ("WAP_BASE_SOURCES", "webrtc/rtc_base/meson.build", "base_sources", "webrtc/rtc_base/"),
    (
        "WAP_COMMON_AUDIO_SOURCES",
        "webrtc/common_audio/meson.build",
        "common_audio_sources",
        "webrtc/common_audio/",
    ),
    (
        "WAP_ISAC_VAD_SOURCES",
        "webrtc/modules/audio_coding/meson.build",
        "isac_vad_sources",
        "webrtc/modules/audio_coding/",
    ),
    (
        "WAP_APM_SOURCES",
        "webrtc/modules/audio_processing/meson.build",
        "webrtc_audio_processing_sources",
        "webrtc/modules/audio_processing/",
    ),
)


def read_list(root: pathlib.Path, meson_path: str, name: str) -> list[str]:
    text = (root / meson_path).read_text()
    match = re.search(rf"^{re.escape(name)}\s*=\s*\[(.*?)\]", text, re.S | re.M)
    if match is None:
        raise SystemExit(f"{meson_path}: no list named {name}")
    return re.findall(r"'([^']+)'", match.group(1))


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    root = pathlib.Path(sys.argv[1])
    version_match = re.search(r"version\s*:\s*'([^']+)'", (root / "meson.build").read_text())
    version = version_match.group(1) if version_match else "unknown"
    out = [HEADER.format(version=version)]
    for cmake_name, meson_path, meson_name, prefix in LISTS:
        out.append(f"set({cmake_name}")
        for item in read_list(root, meson_path, meson_name):
            out.append(f"  {prefix}{item}")
        out.append(")")
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
