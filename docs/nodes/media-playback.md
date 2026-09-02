---
summary: "Inline audio and video playback across the Control UI and native apps"
read_when:
  - Playing or troubleshooting audio and video attachments in chat
  - Comparing media format support across OpenClaw clients
  - Debugging playback metadata, transcoding, or codec availability
title: "Media playback"
---

OpenClaw chat clients play assistant audio and video attachments inline. The
Gateway keeps those attachments behind session-scoped access, serves seekable
byte ranges, and can prepare a portable playback rendition for recognized
formats that are not safe across every client.

This page covers playback in OpenClaw clients. Channel delivery, inbound media
understanding, and live voice conversations use separate paths; see
[Image and media support](/nodes/images),
[Media understanding](/nodes/media-understanding), and [Talk mode](/nodes/talk).

## Client support

| Client          | Playback path                                       | Operator notes                                                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control UI      | Themed inline audio cards and native video controls | Audio cards provide play/pause, seek, elapsed and total time, download, a voice-note badge, and keyboard controls. Space toggles playback; Left/Right seek by five seconds. Starting one audio card pauses the previous one. Video upload is available from the chat attachment picker. |
| iOS and macOS   | `AVAudioPlayer` for audio and `AVPlayer` for video  | Inline media coordinates with Talk and Listen so two speech paths do not play over each other. For a pinned-TLS Gateway, the app performs a bounded authenticated download before video playback instead of bypassing certificate pinning.                                              |
| Android         | Media3 ExoPlayer                                    | The app streams video through the authenticated Gateway HTTP client, requests Android audio focus, and coordinates attachment playback with Talk/TTS. Cached transcript media rows remain visible offline, but playback needs a connection to obtain a fresh media ticket.              |
| Linux companion | Control UI inside the companion WebView             | Codec availability comes from GStreamer. Released packages include or declare the expected codec plugins; see [Linux media codecs](/platforms/linux#media-codecs).                                                                                                                      |

## Portable formats

The Gateway classifies these formats as the portable native set shared by the
browser, Apple players, and Android Media3:

| Kind  | Portable native input                                                                   | Recognized transcode input                                         | Playback target                                          |
| ----- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| Audio | MP3; AAC in M4A/MP4; PCM WAV                                                            | AAC, AIFF, AMR/AMR-WB, CAF, FLAC, Ogg/Opus/Vorbis, WebM audio, WMA | AAC in M4A (`audio/mp4`)                                 |
| Video | H.264 MP4 with a portable profile and 4:2:0 pixel format; AAC or MP3 audio when present | AVI, FLV, Matroska/MKV, QuickTime/MOV, WebM, ASF, WMV              | H.264/AAC MP4 with 4:2:0 pixel format, at most 1920×1080 |

The Linux companion can also play formats supplied by its installed GStreamer
plugins. Browser and operating-system updates may add native formats, but the
table above is the cross-client contract OpenClaw targets.

## Lazy playback renditions

Both Gateway byte routes accept `?playback=1`: the managed attachment route
under `/api/chat/media/outgoing/.../full` and the Control UI assistant-media
route. Attachment metadata can report `playback: "native"` or
`playback: "transcode"` so a client can choose the rendition deliberately.

Playback conversion is lazy:

1. A native source passes through unchanged.
2. A recognized non-portable source starts a bounded `ffmpeg` job. The route
   returns HTTP `202` with `{ "status": "preparing" }` while the rendition is
   being prepared.
3. A later request receives the cached M4A or MP4 rendition.
4. If inspection or conversion is unavailable, fails, or exceeds a limit, the
   route falls back to the original bytes. The client can then show its
   unplayable-media fallback and keep the download action available.

The Control UI checks rendition readiness with `HEAD` before loading the inline
player. It shows **Preparing playback** while conversion is pending and keeps
the download action available when playback is unavailable.

Transcoding accepts sources up to 20 minutes and never raises the normal audio
or video byte cap. Cached playback renditions use a fixed seven-day retention
that Gateway maintenance enforces at startup and hourly, independently of
`attachments.ttlHours`.

## Managed attachments and access

Agent-produced audio and video are stored as managed media artifacts. Images
keep their separate managed-image artifact family. Native clients resolve the
artifact through `artifacts.download`, which returns inline base64 bytes when
the artifact is byte-backed or a short-lived, ticketed URL when it is
Gateway-managed.

Native clients resolve ticketed media against the connected Gateway URL,
preserving its reverse-proxy path prefix. A Gateway reached at
`wss://gateway.example/openclaw` loads managed media beneath
`https://gateway.example/openclaw/api/chat/media/outgoing/`, not the server root.

The ticketed byte routes support:

- `Range` requests with HTTP `206 Partial Content` for seeking
- `ETag` and `If-Range` for safe resume behavior
- `HEAD` requests with the same content metadata and no response body

Do not copy a ticketed URL into durable configuration. Clients reacquire a
ticket from the authenticated Gateway when needed.

## Metadata and limits

Chat attachments may include `sizeBytes`, `durationMs`, `width`, and `height`.
OpenClaw also uses `ffprobe`, when available, to fill audio duration and video
duration/dimensions for media facts and the Control UI `?meta=1` availability
probe. Probing is best-effort: a missing or failed probe leaves fields absent
instead of rejecting the attachment.

Gateway-managed assistant attachments use these per-file caps:

| Kind  | Maximum size |
| ----- | -----------: |
| Image |       12 MiB |
| Audio |       16 MiB |
| Video |       16 MiB |

These are playback/storage caps, not the separate media-understanding limits.
For transcription and description limits, see
[Image and media support](/nodes/images#limits-and-errors).

## Troubleshooting

### Duration or dimensions are missing

Check that `ffprobe` is installed on the Gateway host and visible on its
`PATH`:

```bash
ffprobe -version
```

Playback of an already portable file can still work without metadata.

### A recognized format downloads instead of playing

Check both media tools on the Gateway host:

```bash
ffmpeg -version
ffprobe -version
```

`ffprobe` classifies codecs and duration; `ffmpeg` creates the portable
rendition. If either step cannot safely handle the source, OpenClaw serves the
original file and the client keeps its fallback/download path.

### Playback stays in preparing state

The first rendition request is asynchronous. Wait briefly and retry. Very
large, longer than 20-minute, unprobeable, or unsupported sources remain on the
original-byte fallback instead of blocking the Gateway.

### Linux reports a codec error

Use the package and source-build instructions in
[Linux media codecs](/platforms/linux#media-codecs). The `.deb` depends on the
required GStreamer plugin packages; the AppImage carries the media framework
and codecs installed by the release build.

### Android shows a media row while offline

That is expected. Android caches the transcript metadata, not the attachment
bytes or its short-lived download capability. Reconnect, then play again so the
app can request a new ticket.

## Related

- [Image and media support](/nodes/images)
- [Audio and voice notes](/nodes/audio)
- [Media overview](/tools/media-overview)
- [Text to speech](/tools/tts)
- [Linux app](/platforms/linux)
