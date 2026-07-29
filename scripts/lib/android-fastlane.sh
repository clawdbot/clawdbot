#!/usr/bin/env bash

run_android_fastlane() {
  if command -v fastlane >/dev/null 2>&1 && fastlane --version >/dev/null 2>&1; then
    fastlane "$@"
    return
  fi

  if command -v rbenv >/dev/null 2>&1; then
    local version=""
    while IFS= read -r version; do
      if RBENV_VERSION="${version}" rbenv which fastlane >/dev/null 2>&1; then
        RBENV_VERSION="${version}" rbenv exec fastlane "$@"
        return
      fi
    done < <(rbenv versions --bare)
  fi

  echo "fastlane not found. Install fastlane or select a Ruby version that has the fastlane gem." >&2
  return 127
}
