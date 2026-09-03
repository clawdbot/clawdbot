#!/usr/bin/env bash

# BASH_SOURCE may be relative, so resolve it before callers change directories.
_OPENCLAW_ANDROID_FASTLANE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

run_android_fastlane() {
  local gemfile=""
  gemfile="${_OPENCLAW_ANDROID_FASTLANE_REPO_ROOT}/apps/android/Gemfile"

  local setup_hint=""
  setup_hint="Install Ruby 3.4.10, then run: cd apps/android && gem install bundler -v 2.6.9 && bundle _2.6.9_ install"
  local bundle_error=""
  local bundle_status=1
  if [[ ! -f "$gemfile" ]]; then
    bundle_error="The repository Android Gemfile is missing at ${gemfile}. Restore it from the repository checkout."
  elif ! command -v bundle >/dev/null 2>&1; then
    bundle_error="bundle not found for the Android Fastlane bundle at ${gemfile}."
    bundle_status=127
  elif ! BUNDLE_GEMFILE="$gemfile" bundle _2.6.9_ check >/dev/null 2>&1; then
    bundle_error="The Android Fastlane bundle is not installed for ${gemfile}."
  else
    _OPENCLAW_ANDROID_FASTLANE_EXECUTION_PROVENANCE=locked \
      BUNDLE_GEMFILE="$gemfile" bundle _2.6.9_ exec fastlane "$@"
    return
  fi

  local release_ref_mode="${OPENCLAW_MOBILE_RELEASE_REF_MODE:-}"
  if [[ "$release_ref_mode" =~ ^[[:space:]]*intent[[:space:]]*$ ]]; then
    echo "$bundle_error" >&2
    echo "$setup_hint" >&2
    return "$bundle_status"
  fi

  if command -v fastlane >/dev/null 2>&1 && fastlane --version >/dev/null 2>&1; then
    _OPENCLAW_ANDROID_FASTLANE_EXECUTION_PROVENANCE=fallback fastlane "$@"
    return
  fi

  if command -v rbenv >/dev/null 2>&1; then
    local version=""
    while IFS= read -r version; do
      if RBENV_VERSION="${version}" rbenv which fastlane >/dev/null 2>&1; then
        RBENV_VERSION="${version}" \
          _OPENCLAW_ANDROID_FASTLANE_EXECUTION_PROVENANCE=fallback \
          rbenv exec fastlane "$@"
        return
      fi
    done < <(rbenv versions --bare)
  fi

  echo "$bundle_error" >&2
  echo "$setup_hint" >&2
  return "$bundle_status"
}
