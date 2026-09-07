---
summary: "What the Control UI keeps when the Gateway connection drops, and how it recovers"
read_when:
  - The Control UI shows Reconnecting or drops messages
  - Understanding what happens to queued input while offline
title: "Offline and reconnect"
sidebarTitle: "Offline and reconnect"
---

What survives a dropped connection, and how the Control UI recovers when it returns.

## Connection loss and reconnect

Once a session is established, a dropped Gateway connection does not log you out. The dashboard
stays visible with a floating amber "Gateway connection lost — Reconnecting…" pill under the top
bar while the client retries automatically with backoff (800 ms up to 15 s). Live updates and
realtime/session actions pause until the connection returns; **Retry now** in the pill forces an
immediate attempt. Chat remains editable: ordinary text and attachment sends are kept in the
current tab's gateway/session-scoped browser storage, shown as waiting for reconnect, and sent
automatically when the Gateway returns. Live controls and slash commands remain unavailable while
offline, except that **Stop** can queue an exact local run ID for replay. A session-only stop
is not replayed because newer work may start in that session before the connection returns.

Queued attachments use binary Blobs in the browser's IndexedDB; the outbox keeps only delivery
metadata and payload references in session storage. Attachment bytes stay with the queued input;
the captured queue metadata owns its destination, even when configured main-session defaults change. All attachments
must be stored before the message is admitted, and all must be readable before sending. Failed admission leaves the draft
unsent. Missing or unreadable queued payloads leave a visible row with recovery guidance; the
browser never sends just the remaining attachments. Binary outbox storage requires browser
storage access. On plain HTTP, each page load uses a fresh payload owner because Web Locks are
unavailable; reloads and duplicated tabs copy payloads before sending and leave the old bounded
payload for browser-storage cleanup. Gateway attachment limits still apply.

The outbox retains up to 25 MiB of attachments per message and 250 MiB across this browser origin,
subject to the browser's own quota. Queued payloads have no age-based expiry. Delivery or discard
releases them; closing a tab or interrupting a tab copy or cleanup can leave orphaned payloads
within that bound. If capacity remains
full after sending or discarding your queues, save any needed drafts before clearing this site's
browser storage. That also clears browser-local drafts and sign-in state. Outbox queues belong to
the browser tab; they are distinct from restart-recoverable composer drafts. Incognito sessions
keep their existing tab-only inline outbox and its smaller browser storage limit; they never
store queued attachment Blobs in IndexedDB.

Duplicating a tab copies the same submission IDs. Once opened, the duplicate claims its own
payload copies and marks those submissions **Delivery unconfirmed**. Check the conversation
before retrying. A duplicate first opened after the source discarded or delivered a message may
instead report missing attachments. Independent tabs do not share newly authored outbox messages.

After connecting, chat waits for account-scoped recovery before accepting or sending ordinary
messages. During this brief check, submitted text and attachments stay in the composer. Offline
queues resume once recovery is ready, unless the session still owns an unresolved initial turn;
resolve that turn with its **Retry** or **Check delivery** action first.

If the connection drops before a send is acknowledged, reconnect checks the transcript and
the session's active or last run ID for delivery proof. A matching run confirms receipt even
before its transcript row appears. Without proof, an attempted message stays in the conversation
with an amber **Delivery unconfirmed** footer, **Retry**, and **Discard**. Check the conversation and retry only
if the message did not arrive. Discard removes the pending copy from this browser's outbox; it does not
undo or cancel work the Gateway already accepted. Later queued messages stay paused until the earlier
unconfirmed message is resolved or discarded, and the queue explains that blockage. Discarding the
earlier message lets the next queued message proceed when the session is ready. Unconfirmed local
commands keep their retry/discard queue controls.

If the Gateway reports that a `/steer` or `/redirect` message failed to start, the Control UI
restores the submitted draft when the composer is still empty. It preserves newer text and
attachments. If you switched conversations, recovery stays with the original conversation.

Queued messages and drafts keep the conversation and agent selected when they were created.
Switching agents, opening a split pane, or reloading does not move them to another destination.
A literal `global` conversation keeps its captured agent; an agent's main conversation stays
separate unless the Gateway is configured with global session scope.

Older browser state may have combined several destinations into one bucket. The Control UI uses
metadata version 4 (`openclaw.control.chatComposer.v4:`), migrating version 1, 2, and 3 records
directly when their destination is still identifiable. It verifies the new metadata before
removing an older source, retaining complete sources when storage or recovery capacity blocks
migration. This metadata change does not change the IndexedDB schema or durable-draft keys. Ambiguous records appear under
**Saved messages need a destination** and remain unsent. Open the intended non-Incognito conversation with
an empty composer and queue, expand the notice, and choose **Restore here for review**. Confirm
the displayed conversation key and agent. Recovered queued messages stay paused: check for
previous delivery before using **Retry**. Recovered attachment drafts return to the composer
without sending. Reconnect, a replacement session, or enabling Incognito while confirmation is
open cancels the transfer; confirm again in the intended conversation. Older attachment drafts
whose destination is known stay cleared when that destination has a newer clear. Ambiguous saved
data remains available for review. Queued Blob references and original submission IDs survive
both automatic migration and explicit destination recovery. Credential-bound messages are shown
only under their original Gateway credential scope, including when an older bucket contains
messages from several scopes. Moving a message into or out of recovery does not delete its bytes;
cleanup follows verified delivery or discard and accounts for retained recovery messages too.
If the destination changes, a newer draft appears, or storage fails, recovery keeps the source
available rather than overwriting newer input. Do not clear browser site data
while you still have saved messages or attachment drafts to recover.

First opens and reloads show a small animated OpenClaw mark while the Gateway resolves the initial
connection, including when authentication comes from a trusted proxy or Tailscale instead of a
browser-stored credential. The login gate appears only after the initial connection fails or the
Gateway actively rejects authentication (bad token/password, missing trusted identity, revoked
pairing) — states that need your input rather than waiting.
