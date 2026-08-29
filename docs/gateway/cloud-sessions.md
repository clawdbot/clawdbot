---
summary: "Run sessions on paired devices or throwaway cloud machines while the Gateway keeps the transcript, workspace, and credentials"
title: "Cloud Sessions"
sidebarTitle: "Cloud Sessions"
read_when: "You want sessions to run somewhere other than the Gateway host, or you are choosing between paired devices, cloud workers, automatic placement, and idle suspension."
status: active
doc-schema-version: 1
---

A cloud session is an ordinary session whose coding work runs on another machine. It appears in the sidebar, streams into chat, and keeps its transcript exactly like a local session — the Gateway stays the owner of the conversation, the reconciled workspace, model credentials, and placement records, while commands, file edits, and tool work execute remotely. If the remote machine disappears, the session and its durable state survive; how it resumes depends on the destination — cloud workers are replaced automatically on the next message, while an offline paired device keeps its placement and waits for the device to return.

Sessions can run in three places, and every one of them uses the same session, the same chat, and the same Place picker:

| Destination       | The machine                                                                       | Best for                                                    | Scope to dispatch |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------- |
| Gateway (default) | The host running `openclaw gateway`                                               | Everyday sessions                                           | —                 |
| Paired device     | Your own hardware, connected once with `openclaw connect`                         | Spare Macs, build boxes, servers you already own            | `operator.write`  |
| Cloud worker      | A throwaway machine leased through [Crabbox](https://github.com/openclaw/crabbox) | Burst capacity, long jobs, isolation from your own machines | `operator.admin`  |

In all remote placements, model inference stays proxied through the Gateway — provider credentials never reach the remote machine — and completed work reconciles back into the session's managed worktree. Both the OpenClaw runtime (`worker-turn`) and Codex (`remote-exec`) can use the same destinations.

## Paired devices: your own hardware as session hosts

Pair any machine with one pasted command, then opt it into session hosting:

```bash
openclaw connect <join-url> --service --session-host
```

The device holds an outbound connection to the Gateway, advertises worker slots (one per CPU core by default, tunable with `nodeHost.workerRuns.capacity`), and can optionally run each hosted session in a Docker-compatible container (`nodeHost.workerRuns.isolation: "container"`). A device that goes offline keeps its active placement — the session waits for it to reconnect rather than losing work.

The node host reconnects after transient transport loss. A worker child has a bounded 120-second admission window. If that window expires **before the turn starts**, the Gateway can launch another child, up to five attempts total (about ten minutes plus backoff), within the original turn timeout. Launch retries use exponential backoff with jitter; each attempt keeps its own terminal result and reason in the node launch journal. Credential and build rejections are terminal, and work that already started is never replayed by this policy.

If a journal-terminal worker has released its turn claim but teardown stalls, stuck-session recovery records the turn failure after a 30-second cleanup grace, on the next diagnostic cycle. Live workers and turns that still hold their claims are unaffected. On Gateway restart, orphan workspace cleanup for failed placements runs in the background after readiness; ownership fencing and pending workspace-result recovery still run before readiness.

See [Nodes](/nodes) for pairing, capacity, isolation, and offline behavior, and [Connect](/cli/connect) for the CLI.

## Cloud workers: rented machines through Crabbox

Configure a profile under `cloudWorkers.profiles` and the bundled Crabbox plugin provisions machines on demand across cloud backends (AWS, Hetzner, and others), runs your setup command, enrolls the box as a temporary node, and tears everything down when the session stops. The machine is disposable by design: no standing credentials live on it, and the durable state stays with the Gateway.

See [Cloud Workers](/gateway/cloud-workers) for profiles, requirements, dispatching, moving sessions between destinations, and the security model.

## Automatic load balancing across devices

You do not have to pick a device. Choosing **Auto** (least-busy device) in the Place picker — or dispatching with `autoDevice: true` — selects a paired session host automatically and retries up to three ranked hosts if provisioning fails before a machine is allocated. OpenClaw `worker-turn` placements rank hosts by most free worker slots, breaking ties by device ID; Codex `remote-exec` placements do not consume worker slots, so eligible hosts are ranked by device ID alone. When no host qualifies, the error says exactly why: no session hosts paired, all disconnected, or all at capacity.

See [Nodes](/nodes#host-openclaw-sessions) for the selection rules and [Control UI](/web/control-ui) for the picker.

## Sleeping and waking: idle suspension and warm images

Two profile settings turn cloud workers from always-on machines into compute that sleeps when idle:

- `suspendAfter: "2h"` — after the session has been idle for the duration, the Gateway performs the same safe stop as **Stop cloud worker…**: it reconciles the workspace first, then releases the machine. While suspended, you pay for retained snapshot storage only. The next message provisions a replacement automatically — no button to press.
- `settings.warmImage` — capture a scrubbed machine image when a worker stops, and start later workers for the same profile from that image instead of provisioning cold. On by default, so a suspended session wakes on a warm machine in a fraction of the cold provisioning time. Profiles that forward host environment into setup (`setupEnv`) capture only when you opt in explicitly, and `settings.warmImage: false` keeps any profile cold.

With warm images enabled, repeat sessions for the same repository can also avoid a fresh clone. For clean workspaces eligible for the published-origin path, node-tunnel sync copies the machine's per-repository Git seed, fetches only the Git delta, and checks out the requested commit. Other workspaces keep the normal sync path.

Suspension never interrupts work: sessions with an active turn, queued messages, or unreconciled results are skipped and re-checked on the next sweep. See the profile fields in [Cloud Workers](/gateway/cloud-workers#configuration) for costs, capture boundaries, and prerequisites.

## Images and PDFs

Attach images and PDFs through the normal chat composer, including on later turns in an existing cloud session. The Gateway prepares image input, including rendered pages from scanned PDFs, before sending it to an OpenClaw worker. Codex receives image input through its Gateway-side app-server.

Original attachments are copied into the placed session's remote workspace before execution. The turn includes the remote paths so file tools can inspect the originals without using Gateway-local filenames. Attachment transfer does not replace the remote workspace or overwrite existing work. Model credentials remain on the Gateway.

## What stays with the Gateway

Placement is disposable; the session is not. The transcript, the last-reconciled workspace files, placement history, and every provider credential live with the Gateway in all placements. A dead cloud machine or an idle suspension resolves automatically: the session remains in your sidebar, and the next message provisions a replacement — warm when an image exists, cold otherwise. An offline paired device is different by design: the placement stays active and waits for the device to reconnect, and **Continue on Gateway…** is an explicit action that can lose unsynced device files. Workspace changes made after the last reconciliation are the only loss window, and clean stops (including auto-suspension) reconcile before releasing the machine.

## Related

- [Cloud Workers](/gateway/cloud-workers) — profiles, dispatch, moves, security model
- [Nodes](/nodes) — pairing, session hosting, capacity, container isolation
- [Control UI](/web/control-ui) — the Place picker and session badges
- [Connect](/cli/connect) — one-command device onboarding
- [Managed worktrees](/concepts/managed-worktrees) — the workspace cloud sessions reconcile into
- [Sandboxing](/gateway/sandboxing) — reducing blast radius for local execution instead
