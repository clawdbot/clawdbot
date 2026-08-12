#!/usr/bin/env bash
set -euo pipefail

mode="${1:?mode is required}"
sticky_root="${2:?sticky root is required}"
workspace="${3:-}"
archive="$sticky_root/importer-node-modules.tar"
archive_checksum="$sticky_root/.openclaw-importer-archive.sha256"
importer_manifest="$sticky_root/importer-node-modules.manifest"
marker="$sticky_root/.openclaw-deps-fingerprint"
force_commit_sentinel="$sticky_root/.openclaw-force-commit"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

archive_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

clear_importers() {
  (
    cd "$workspace"
    find . \( -type d -o -type l \) -name node_modules -prune \
      ! -path ./node_modules -exec rm -rf -- {} +
  )
}

verify_importers() {
  node "$script_dir/verify-importers.mjs" "$workspace" "$1"
}

case "$mode" in
  capture)
    workspace="${workspace:?workspace is required}"
    fingerprint="${4:?fingerprint is required}"
    rebuild_signal="${5:?rebuild signal is required}"
    mkdir -p "$sticky_root"
    list_file="$(mktemp)"
    temp_archive="$archive.tmp.$$"
    temp_checksum="$archive_checksum.tmp.$$"
    temp_manifest="$importer_manifest.tmp.$$"
    temp_marker="$marker.tmp.$$"
    cleanup() {
      rm -f "$list_file" "$temp_archive" "$temp_checksum" "$temp_manifest" "$temp_marker"
    }
    trap cleanup EXIT
    # Do not publish a fingerprint for an install whose importer resolution is
    # already falling through to a wrong hoisted version.
    rm -f "$marker" "$archive_checksum" "$importer_manifest"
    (
      cd "$workspace"
      find . \( -type d -o -type l \) -name node_modules -prune \
        ! -path ./node_modules -print0 >"$list_file"
      tar --create --file "$temp_archive" --null --files-from "$list_file"
    )
    tr '\0' '\n' <"$list_file" >"$temp_manifest"
    # Record the exact importer set and check its live resolution before a
    # writer can publish the marker.
    verify_importers "$temp_manifest"
    {
      archive_sha256 "$temp_archive"
      archive_sha256 "$temp_manifest"
    } >"$temp_checksum"
    mv "$temp_archive" "$archive"
    mv "$temp_manifest" "$importer_manifest"
    mv "$temp_checksum" "$archive_checksum"
    # The marker lands last. Consumers also verify the archive bytes and every
    # registry-backed importer resolution before trusting this snapshot.
    printf '%s\n' "$fingerprint" >"$temp_marker"
    mv "$temp_marker" "$marker"
    : >"$rebuild_signal"
    ;;
  restore)
    workspace="${workspace:?workspace is required}"
    if [[ ! -f "$archive" || ! -f "$archive_checksum" || ! -f "$importer_manifest" ]]; then
      echo "sticky importer archive, manifest, or checksum is missing under $sticky_root" >&2
      exit 1
    fi
    expected_archive_checksum="$(sed -n '1p' "$archive_checksum" | tr -d '[:space:]')"
    expected_manifest_checksum="$(sed -n '2p' "$archive_checksum" | tr -d '[:space:]')"
    actual_archive_checksum="$(archive_sha256 "$archive")"
    actual_manifest_checksum="$(archive_sha256 "$importer_manifest")"
    if [[ ! "$expected_archive_checksum" =~ ^[a-f0-9]{64}$ ]] || \
      [[ ! "$expected_manifest_checksum" =~ ^[a-f0-9]{64}$ ]] || \
      [[ "$actual_archive_checksum" != "$expected_archive_checksum" ]] || \
      [[ "$actual_manifest_checksum" != "$expected_manifest_checksum" ]]; then
      echo "sticky importer archive or manifest checksum mismatch" >&2
      exit 1
    fi
    # A restored archive is authoritative for checkout-local importer links.
    # Clear first so entries absent from the archive cannot survive from a
    # reused workspace, and clear again when validation rejects the restore.
    clear_importers
    if ! tar --extract --file "$archive" --directory "$workspace"; then
      clear_importers
      exit 1
    fi
    if ! verify_importers "$importer_manifest"; then
      clear_importers
      exit 1
    fi
    ;;
  ensure-change)
    initial_usage_bytes="${3:?initial usage bytes are required}"
    if [[ ! "$initial_usage_bytes" =~ ^[0-9]+$ ]] || [[ "$initial_usage_bytes" -le 0 ]]; then
      echo "invalid initial sticky disk usage: $initial_usage_bytes" >&2
      exit 2
    fi
    current_usage_bytes() {
      df -B1 --output=used "$sticky_root" | tail -n1 | tr -d '[:space:]'
    }
    allocation_delta() {
      local current="$1"
      if [[ "$current" -ge "$initial_usage_bytes" ]]; then
        echo $((current - initial_usage_bytes))
      else
        echo $((initial_usage_bytes - current))
      fi
    }

    # The pinned StickyDisk action commits only when the absolute whole-disk
    # allocation delta exceeds 4096 bytes. Measure against the same baseline
    # after store pruning, then leave a 64 KiB margin for its post phase.
    target_delta_bytes=65536
    max_sentinel_bytes=1048576
    current="$(current_usage_bytes)"
    if [[ ! "$current" =~ ^[0-9]+$ ]] || [[ "$current" -le 0 ]]; then
      echo "could not read current sticky disk usage" >&2
      exit 1
    fi
    delta="$(allocation_delta "$current")"
    if [[ "$delta" -le "$target_delta_bytes" ]] &&
      [[ -f "$force_commit_sentinel" ]] &&
      [[ "$(stat -c %s "$force_commit_sentinel")" -ge "$max_sentinel_bytes" ]]; then
      : >"$force_commit_sentinel"
      sync
      current="$(current_usage_bytes)"
      delta="$(allocation_delta "$current")"
    fi
    for _ in 1 2 3; do
      if [[ "$delta" -gt "$target_delta_bytes" ]]; then
        echo "Sticky dependency rebuild changed allocation by ${delta} bytes"
        exit 0
      fi
      bytes_needed=$((initial_usage_bytes + target_delta_bytes + 4096 - current))
      blocks_needed=$(((bytes_needed + 4095) / 4096))
      if [[ "$blocks_needed" -lt 1 ]]; then
        blocks_needed=1
      fi
      dd if=/dev/zero bs=4096 count="$blocks_needed" status=none >>"$force_commit_sentinel"
      sync
      current="$(current_usage_bytes)"
      delta="$(allocation_delta "$current")"
    done
    echo "could not force a detectable sticky disk allocation change (delta: ${delta} bytes)" >&2
    exit 1
    ;;
  *)
    echo "unsupported sticky importer mode: $mode" >&2
    exit 2
    ;;
esac
