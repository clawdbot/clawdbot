# Matrix Spec Support

Current Matrix spec/event support tracked for the bundled Matrix plugin.

Scope:

- code-backed today-state only
- plugin behavior only; not a claim of full Matrix spec coverage
- update this file when adding or removing Matrix event/spec support

Legend:

- `in`: inbound handling
- `out`: outbound send/edit/emit
- `tools`: CLI/action/runtime tooling built on that surface

## Support Matrix

| Surface                  | Spec / event ids                                                                                   | Support      | Notes                                                                    | Evidence                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Core messages            | `m.room.message`                                                                                   | in/out/tools | base text/media message surface                                          | `src/matrix/send/types.ts`, `src/matrix/actions/messages.ts`                                                               |
| Rich text                | `org.matrix.custom.html`                                                                           | out          | Markdown rendered to Matrix HTML                                         | `src/matrix/send/formatting.ts`                                                                                            |
| Replies                  | `m.in_reply_to`                                                                                    | in/out       | reply relation support                                                   | `src/matrix/send/formatting.ts`                                                                                            |
| Edits                    | `m.replace`                                                                                        | in/out/tools | Matrix edit flow; edit body uses `* <text>` fallback format              | `src/matrix/send/types.ts`, `src/matrix/draft-stream.test.ts`                                                              |
| Threads                  | `m.thread`                                                                                         | in/out/tools | thread send, routing, session/thread policy                              | `src/matrix/send/types.ts`, `src/matrix/monitor/types.ts`, `src/matrix/monitor/threads.test.ts`                            |
| Direct rooms             | `m.direct`                                                                                         | in/out/tools | DM routing, cache, repair, outbound target selection                     | `src/matrix/send/types.ts`, `src/matrix/sdk.ts`, `src/matrix/send/targets.test.ts`, `src/matrix/direct-management.test.ts` |
| Reactions                | `m.reaction`, `m.annotation`                                                                       | in/out/tools | send, summarize, inbound reaction routing                                | `src/matrix/reaction-common.ts`, `src/matrix/monitor/reaction-events.test.ts`                                              |
| Read receipts            | `m.read`                                                                                           | out          | sent on inbound message receipt                                          | `src/matrix/sdk.ts`, `src/matrix/monitor/handler.ts`                                                                       |
| Typing                   | typing API                                                                                         | out          | typing keepalive while reply runs                                        | `src/matrix/sdk.ts`, `src/matrix/send.ts`, `src/matrix/monitor/handler.ts`                                                 |
| Mentions                 | `m.mentions`                                                                                       | in/out/tools | stable mention metadata on sends/edits/media captions/poll fallback text | `src/matrix/send/formatting.ts`, `src/matrix/monitor/mentions.ts`, `src/matrix/send.test.ts`                               |
| Mention link compat      | `https://matrix.to/#/...`                                                                          | in/out       | emit + validate visible-label mentions in formatted HTML                 | `src/matrix/format.ts`, `src/matrix/monitor/mentions.ts`                                                                   |
| Polls                    | `m.poll.start`, `m.poll.response`, `m.poll.end`                                                    | in/out/tools | stable poll create/read/vote/summary flow                                | `src/matrix/poll-types.ts`, `src/matrix/actions/polls.ts`, `src/matrix/poll-summary.ts`                                    |
| Poll compat              | `org.matrix.msc3381.poll.start`, `org.matrix.msc3381.poll.response`, `org.matrix.msc3381.poll.end` | in/out       | unstable poll compat still emitted/parsed where needed                   | `src/matrix/poll-types.ts`, `src/matrix/send.test.ts`                                                                      |
| Poll relations           | `m.reference`                                                                                      | in/out/tools | poll votes/results linked to root poll event                             | `src/matrix/poll-types.ts`, `src/matrix/actions/polls.ts`, `src/matrix/poll-summary.ts`                                    |
| Extensible text fallback | `org.matrix.msc1767.text`                                                                          | in/out       | poll text fallback/compat                                                | `src/matrix/poll-types.ts`                                                                                                 |
| Voice messages           | `org.matrix.msc3245.voice`                                                                         | out          | voice-bubble marker on compatible audio sends                            | `src/matrix/send/media.ts`, `src/matrix/send/types.ts`                                                                     |
| Voice audio metadata     | `org.matrix.msc1767.audio`                                                                         | out          | duration metadata for voice sends                                        | `src/matrix/send/media.ts`, `src/matrix/send/types.ts`                                                                     |
| Location                 | `m.location`, `geo:`                                                                               | in           | inbound parse to text/context; no outbound location send tracked here    | `src/matrix/monitor/types.ts`, `src/matrix/monitor/location.ts`, `src/matrix/monitor/handler.ts`                           |
| E2EE room events         | `m.room.encrypted`                                                                                 | in/out/tools | encrypted event hydration, decrypt, encrypted media send                 | `src/matrix/monitor/types.ts`, `src/matrix/sdk.ts`, `docs/channels/matrix.md`                                              |
| Encrypted media previews | `file`, `thumbnail_file`                                                                           | out          | encrypted thumbnails for encrypted image events                          | `src/matrix/send/media.ts`, `docs/channels/matrix.md`                                                                      |
| Device verification      | `m.key.verification.*`, `m.key.verification.request`                                               | in/tools     | request/ready/start/SAS/done/cancel notices and CLI flows                | `src/matrix/monitor/verification-utils.ts`, `src/matrix/monitor/events.test.ts`, `docs/channels/matrix.md`                 |
| Streaming/live markers   | `org.matrix.msc4357.live`                                                                          | out          | live draft/edit markers for partial streaming                            | `src/matrix/send/types.ts`, `src/matrix/send.ts`, `src/matrix/draft-stream.ts`                                             |

## Explicit MSCs In Use

These MSCs are explicitly referenced in the plugin today:

- `MSC3381`: polls
- `MSC1767`: extensible-events fallback fields used for polls and voice metadata
- `MSC3245`: voice message marker
- `MSC4357`: live streaming marker

Evidence:

- `src/matrix/poll-types.ts`
- `src/matrix/send/media.ts`
- `src/matrix/send/types.ts`
- `src/matrix/draft-stream.ts`

## Non-goals

This file does not claim:

- full client-server API coverage
- full room-state/event coverage inherited from `matrix-js-sdk`
- outbound support for any surface not listed above

If a new Matrix feature lands, add a row with:

1. exact event/spec id
2. support shape (`in`, `out`, `tools`)
3. at least one code path proving it

## Missing / Candidate Specs

Recommended next additions, prioritized by user-visible value and closeness to current code:

| Priority | Surface                       | Spec / event ids                              | Why add it                                                                                         | Current gap                                                                      |
| -------- | ----------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| high     | Sticker messages              | `m.sticker`                                   | stable spec; common client surface; we already classify sticker attachments on read paths          | no explicit inbound `m.sticker` event handling and no outbound sticker send path |
| high     | Outbound location messages    | `m.location`, `geo_uri`                       | stable spec; docs already say Matrix supports location, but current implementation is inbound-only | no outbound location send/action API                                             |
| medium   | Private + richer read markers | `m.read.private`, `m.fully_read`              | stable spec; better privacy and cleaner read-state behavior than public-only `m.read`              | current code only sends public `m.read` receipts                                 |
| medium   | Thread-aware receipts         | `m.read` with `thread_id`                     | stable spec; better alignment with Matrix thread UX                                                | current receipt send path has no `thread_id` support                             |
| medium   | Unread markers                | `m.marked_unread`                             | stable spec; useful for operator workflows and room triage tooling                                 | no room account-data support for unread markers                                  |
| low      | Emote messages                | `m.emote`                                     | stable spec; easy parity win for bots/action tools                                                 | no explicit send/action support                                                  |
| low      | Poll close parity             | `m.poll.end`, `org.matrix.msc3381.poll.end`   | completes the poll lifecycle on a surface we already parse                                         | plugin parses poll-end events but does not expose an outbound close flow         |
| low      | Animated media metadata       | `info.is_animated` on `m.image` / `m.sticker` | newer stable metadata; helps clients decide whether to fetch/render animated originals             | media info builders do not populate animation metadata                           |

### Why these are listed

- `m.sticker` is a stable spec surface in the latest Matrix Client-Server API, and the plugin already has partial sticker awareness in message summarization.
- `m.location` is a stable spec surface in the latest Matrix Client-Server API. The plugin currently parses inbound location events from `geo_uri`, but does not send them.
- `m.read.private`, `m.fully_read`, and threaded receipts are stable read-marker/read-receipt surfaces in the latest Matrix Client-Server API. The plugin currently posts plain `m.read` receipts only.
- `m.marked_unread` is a stable room account-data surface in the latest Matrix Client-Server API and would be useful if Matrix actions grow more operator/client-like room triage controls.
- `m.emote` is a stable message type and a relatively small addition compared with the items above.
- `m.poll.end` is already represented in local poll types, so exposing a close-poll send/tool flow is a contained follow-up.
- `info.is_animated` is a smaller metadata-parity item, but easy to miss once sticker support exists.

### Probably not worth prioritizing here

- VoIP / `m.call.*`: valid Matrix spec area and a plausible future direction here, just not a near-term priority relative to messaging, receipt, and room-state gaps.

### Gap Evidence

- sticker partial only: `src/matrix/media-text.ts`
- location inbound only: `src/matrix/monitor/location.ts`, `src/matrix/monitor/handler.ts`
- public receipt only: `src/matrix/sdk.ts`, `src/matrix/send.ts`, `src/matrix/monitor/handler.ts`
- poll-end constants only: `src/matrix/poll-types.ts`
- no animation metadata emit: `src/matrix/send/media.ts`

### External Spec References

- latest Matrix Client-Server API: <https://spec.matrix.org/latest/client-server-api/index.html>
- `m.sticker`: <https://spec.matrix.org/latest/client-server-api/#msticker>
- `m.location`: <https://spec.matrix.org/latest/client-server-api/#mlocation>
- receipts and read markers (`m.read.private`, `m.fully_read`, `m.marked_unread`): <https://spec.matrix.org/latest/client-server-api/#receipts>
