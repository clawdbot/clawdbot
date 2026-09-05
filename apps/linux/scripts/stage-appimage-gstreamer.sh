#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 OUTPUT_DIR" >&2
  exit 2
fi

command -v gst-inspect-1.0 >/dev/null || {
  echo "gst-inspect-1.0 is required" >&2
  exit 1
}

output=$1
parent=$(dirname "$output")
mkdir -p "$parent"
parent=$(cd "$parent" && pwd -P)
output="$parent/$(basename "$output")"
staging=$(mktemp -d "$parent/.openclaw-gstreamer.XXXXXX")
trap 'rm -rf "$staging"' EXIT

# linuxdeploy's GStreamer plugin recursively bundles the dependency closure of
# every staged plugin. Keep this list at the media capabilities the companion
# ships so optional host plugins cannot pull unrelated libraries into AppRun.
elements=(
  filesrc
  queue
  typefind
  typefindfunctions
  appsrc
  appsink
  giosrc
  souphttpsrc
  playbin
  decodebin
  audioconvert
  audioresample
  volume
  videoconvert
  videoscale
  videorate
  autoaudiosink
  pulsesink
  qtdemux
  matroskademux
  wavparse
  oggdemux
  opusparse
  opusdec
  vorbisdec
  vp8dec
  vp9dec
  aacparse
  h264parse
  id3demux
  mpegaudioparse
  avdec_aac
  avdec_h264
  avdec_mp3
)

declare -A sources=()
for element in "${elements[@]}"; do
  inspection=$(gst-inspect-1.0 "$element")
  plugin=$(awk '$1 == "Filename" { print $2; exit }' <<<"$inspection")
  if [[ ! -f "$plugin" ]]; then
    echo "missing GStreamer plugin for $element" >&2
    exit 1
  fi

  name=$(basename "$plugin")
  source=$(realpath "$plugin")
  if [[ -n ${sources[$name]:-} && ${sources[$name]} != "$source" ]]; then
    echo "conflicting GStreamer plugins named $name" >&2
    exit 1
  fi
  if [[ -z ${sources[$name]:-} ]]; then
    cp -L "$plugin" "$staging/$name"
    sources[$name]=$source
  fi
  printf '%s\t%s\n' "$element" "$name"
done

rm -rf "$output"
mv "$staging" "$output"
trap - EXIT
