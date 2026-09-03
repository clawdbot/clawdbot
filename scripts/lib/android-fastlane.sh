#!/usr/bin/env bash

# BASH_SOURCE may be relative, so resolve it before callers change directories.
_OPENCLAW_ANDROID_FASTLANE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

run_android_fastlane() {
  local gemfile=""
  gemfile="${_OPENCLAW_ANDROID_FASTLANE_REPO_ROOT}/apps/android/Gemfile"

  local setup_hint=""
  setup_hint="Install Ruby 3.4.10, then run: cd apps/android && gem install bundler -v 2.6.9 && bundle _2.6.9_ install"
  if [[ ! -f "$gemfile" ]]; then
    echo "The repository Android Gemfile is missing at ${gemfile}. Restore it from the repository checkout." >&2
    echo "$setup_hint" >&2
    return 1
  fi
  if ! command -v bundle >/dev/null 2>&1; then
    echo "bundle not found for the Android Fastlane bundle at ${gemfile}." >&2
    echo "$setup_hint" >&2
    return 127
  fi
  if ! BUNDLE_GEMFILE="$gemfile" bundle _2.6.9_ check >/dev/null 2>&1; then
    echo "The Android Fastlane bundle is not installed for ${gemfile}." >&2
    echo "$setup_hint" >&2
    return 1
  fi
  BUNDLE_GEMFILE="$gemfile" bundle _2.6.9_ exec fastlane "$@"
}
