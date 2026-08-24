#!/usr/bin/env bash

run_ios_fastlane() {
  local gemfile=""
  gemfile="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/apps/ios/Gemfile"

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
