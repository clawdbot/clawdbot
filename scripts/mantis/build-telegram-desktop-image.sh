#!/usr/bin/env bash
set -euo pipefail

image_tag="openclaw-telegram-desktop:7.0.9"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image_dir="$script_dir/telegram-desktop-image"
build_args=()

case "${1:-}" in
  "") ;;
  --no-cache) build_args+=(--no-cache) ;;
  -h | --help)
    printf 'Usage: scripts/mantis/build-telegram-desktop-image.sh [--no-cache]\n'
    exit 0
    ;;
  *)
    printf 'unknown argument: %s\n' "$1" >&2
    exit 2
    ;;
esac

if [[ "$#" -gt 1 ]]; then
  printf 'expected at most one argument\n' >&2
  exit 2
fi

docker build "${build_args[@]}" --tag "$image_tag" "$image_dir"
printf '%s\n' "$image_tag"
