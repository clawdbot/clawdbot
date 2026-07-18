#!/usr/bin/env bash
set -euo pipefail

mode="${1:?mode is required}"
sticky_root="${2:?sticky root is required}"
workspace="${3:?workspace is required}"
archive="$sticky_root/importer-node-modules.tar"
marker="$sticky_root/.openclaw-deps-fingerprint"

case "$mode" in
  capture)
    fingerprint="${4:?fingerprint is required}"
    mkdir -p "$sticky_root"
    list_file="$(mktemp)"
    temp_archive="$archive.tmp.$$"
    cleanup() {
      rm -f "$list_file" "$temp_archive"
    }
    trap cleanup EXIT
    (
      cd "$workspace"
      find . -type d -name node_modules -prune ! -path ./node_modules -print0 >"$list_file"
      tar --create --file "$temp_archive" --null --files-from "$list_file"
    )
    mv "$temp_archive" "$archive"
    # The marker lands last: a fingerprint is only ever visible next to the
    # importer archive it describes, so consumers cannot restore a torn pair.
    printf '%s\n' "$fingerprint" > "$marker"
    ;;
  restore)
    if [[ ! -f "$archive" ]]; then
      echo "::error::sticky importer node_modules archive is missing: $archive" >&2
      exit 1
    fi
    tar --extract --file "$archive" --directory "$workspace"
    ;;
  *)
    echo "unsupported sticky importer mode: $mode" >&2
    exit 2
    ;;
esac
