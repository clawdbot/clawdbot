#!/usr/bin/env bash

# BASH_SOURCE may be relative, so resolve it before callers change directories.
_OPENCLAW_IOS_FASTLANE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

run_ios_fastlane() {
  local gemfile=""
  gemfile="${_OPENCLAW_IOS_FASTLANE_REPO_ROOT}/apps/ios/Gemfile"

  local setup_hint=""
  setup_hint="Install Ruby 3.4.10, then run: cd apps/ios && gem install bundler -v 2.6.9 && bundle _2.6.9_ install"
  if [[ ! -f "$gemfile" ]]; then
    echo "The repository iOS Gemfile is missing at ${gemfile}. Restore it from the repository checkout." >&2
    echo "$setup_hint" >&2
    return 1
  fi
  if ! command -v bundle >/dev/null 2>&1; then
    echo "bundle not found for the iOS Fastlane bundle at ${gemfile}." >&2
    echo "$setup_hint" >&2
    return 127
  fi
  if ! BUNDLE_GEMFILE="$gemfile" bundle _2.6.9_ check >/dev/null 2>&1; then
    echo "The iOS Fastlane bundle is not installed for ${gemfile}." >&2
    echo "$setup_hint" >&2
    return 1
  fi
  BUNDLE_GEMFILE="$gemfile" bundle _2.6.9_ exec fastlane "$@"
}
