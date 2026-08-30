---
summary: "Dispatch session work to throwaway cloud machines with OpenClaw worker turns or Codex remote execution"
title: "Cloud Workers"
sidebarTitle: "Cloud Workers"
read_when: "You want agent session work to run on ephemeral cloud machines, or you are configuring cloudWorkers profiles."
status: active
doc-schema-version: 1
---

Cloud workers move a session's coding work onto a throwaway cloud machine while the session stays visible in the sidebar and its transcript remains owned by the Gateway. The bundled Crabbox provider boots the box, runs profile setup, and starts `openclaw connect --ephemeral`. One configured Crabbox profile supports both OpenClaw `worker-turn` and Codex `remote-exec` over the same enrolled outbound-node transport. OpenClaw launches a restricted `openclaw worker` child; Codex runs its managed exec-server on the node while keeping app-server and model authentication on the Gateway.

Enrollment is environment-owned and replay-safe. The Gateway persists one setup identity before node enrollment, binds the first authenticated device identity to that exact environment, and reuses the durable device token when provisioning resumes. Initial enrollment and replay both enable worker hosting only for that node process; they do not change durable worker-host configuration. Reclaim or destroy releases the cloud lease and removes the environment-owned node pairing. If provisioning fails before returning a lease, cleanup resolves the original operation’s handle without rerunning provisioning, setup, or enrollment. The handle may refer to an operation that never created a machine; cleanup completes only after the provider confirms release or absence. This does not shorten an in-flight provider operation: teardown waits for that operation to settle.

When the work is done (or the box dies), the machine is discarded. The durable state — transcript, last-reconciled workspace files, and placement records — lives with the Gateway.

A missing setup environment value, a current Crabbox CLI/backend refusal, or changed provider metadata does not prove that an earlier attempt allocated nothing. These failures remain retryable with the original operation identity. Cleanup resolves that operation's handle and retries teardown until the provider confirms release or absence; it never reruns provisioning, setup, or enrollment to discover the lease. Malformed immutable profiles still fail permanently; policy and setup rejections become permanent only after confirmed cleanup.

<Note>
Cloud workers are opt-in. Until you configure a profile, clients hide the Cloud destination and profile dispatch is unavailable. `sessions.dispatch` may still be advertised for eligible paired-device targets. The `cloudWorkers` config schema and the read-only `environments.list` and `environments.status` methods remain available for configuration and environment discovery.
</Note>

## What runs where

| Concern                            | OpenClaw `worker-turn` mode                          | Codex `remote-exec` mode                                |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Agent runtime and turn loop        | Cloud box (`openclaw worker`)                        | Gateway (Codex app-server)                              |
| Command, filesystem, and HTTP work | Cloud box                                            | Cloud node, paired device, or SSH-backed provider       |
| Model inference and provider auth  | Gateway, proxied by `{provider, model}` reference    | Gateway, including ChatGPT subscription or API-key auth |
| Transcript and live session state  | Gateway, fed by the worker's replayable event stream | Gateway through the normal local harness path           |
| Workspace file state               | Changed on the box; reconciled by the Gateway        | Changed remotely; reconciled by the Gateway             |

The bundled Crabbox cloud provider advertises both `worker-turn` and `remote-exec` through its enrolled node transport, so the same cloud profile is available to both harnesses. Codex can also use an explicitly authorized paired device or a provider that retains an SSH-backed remote-execution carrier. A profile that advertises only one mode remains unavailable to the other runtime.

After Crabbox setup, the cloud node dials the Gateway's public TLS endpoint over outbound WebSocket. Worker control, Codex remote execution, and workspace transfer use authenticated node or worker channels, not a Gateway-created reverse tunnel or rsync. Crabbox itself may still require SSH reachability while its CLI runs the provider-owned setup command. Outbound internet access and setup reachability follow the selected backend's network policy; configure them in Crabbox.

OpenClaw `worker-turn` sessions can open [portals](/gateway/portals) on node-backed cloud workers, including the bundled Crabbox provider. For each proxied HTTP or WebSocket connection, the enrolled node redeems a single-use ticket over a TLS-pinned WebSocket to the Gateway and connects to the worker's selected loopback port. This preserves the existing **Control UI → Portals** experience, authentication, and live reload without opening inbound worker ports or creating an SSH tunnel. The tool is available only when the node advertises portal-stream support; older node bundles do not receive it. SSH-backed `remote-exec` placements, including Codex sessions, do not run the OpenClaw worker tool loop, so the `portal` tool does not apply there. Update an unsupported node or move the session back to the Gateway with `sessions.move` when a Gateway-hosted portal is needed.

For a loopback Gateway behind public HTTPS ingress, set `gateway.publicOrigin` to the proxy's bare origin. Node enrollment uses it as the default external pairing endpoint; `plugins.entries.device-pair.config.publicUrl` remains the pairing-specific override. If either URL is behind a reverse proxy, including cloudflared, nginx, or externally managed Tailscale Serve, `gateway.trustedProxies` must include the proxy's source address (typically loopback for a same-host proxy). Otherwise, forwarded client headers cause node enrollment to fail with `proxy_attribution_required`.

## Requirements

- A worker provider plugin. The bundled `crabbox` plugin drives the [Crabbox](https://crabbox.sh/) CLI; Crabbox owns the supported cloud backends and their configuration. Install Crabbox 0.41.1 or newer for the operating-system user that runs the Gateway and put it on that user's `PATH`, or set `settings.binary` to its absolute path. Keeping placed workers alive also requires a release that includes `crabbox heartbeat` (added after v0.43.0). Versions through 0.43.0 can allocate fixed-ID worker leases but lack heartbeat support; OpenClaw continues operating with one warning, and the coordinator may reap a placed worker after its `idleTimeout`.
- For Crabbox AWS workers, the effective `aws.instanceProfile` must be empty. The provider checks `crabbox config show --json` before allocation, then requires `crabbox inspect --json` to report `providerMetadata.instanceProfileAttached: false` from EC2 `DescribeInstances`. Leases with an instance role or without authoritative metadata are stopped and rejected.
- Node.js on the leased machine. Bare cloud images usually lack it — install it in the profile's `setup` command.
- A live, registry-owned session managed worktree (create one with `worktree: true`). Cloud dispatch does not accept an arbitrary plain directory. After dispatch admission, the workspace transport may use manifest mirroring if Git metadata later becomes unavailable; this transport behavior does not make plain directories dispatchable.

### Crabbox provider support

Select a Crabbox backend with `settings.provider`. Use the [Crabbox provider reference](https://crabbox.sh/providers/index.html) for supported providers, authentication, sizing, snapshots, networking, and provider-specific limitations. OpenClaw does not maintain a separate backend catalog; accepting a profile does not establish that the backend can host a cloud session.

The installed Crabbox version and selected backend must support fixed-ID `warmup --lease-id`, POSIX script execution through `run --script-stdin` for setup and enrollment, lease inspection, and teardown by canonical lease ID. Never remove `--lease-id` to bypass a backend capability rejection: it prevents duplicate allocations after an interrupted dispatch. OpenClaw preserves unsupported-backend diagnostics; upgrading the CLI alone does not establish backend support. Heartbeat support keeps placed workers alive under the configured idle policy. Optional desktop and warm-image features have additional requirements described below.

Configure Crabbox for the operating-system user that runs the Gateway. Follow its [authentication guide](https://crabbox.sh/features/auth-admin.html) for coordinator access or the selected provider's guide for direct credentials. Keep credentials out of OpenClaw profile settings and command arguments, and preserve Crabbox's state directory across Gateway restarts so allocation and cleanup can resume safely.

Inspect the installed provider contract and check readiness without allocating a machine:

```bash
crabbox providers --json
crabbox providers describe <backend> --json
crabbox doctor --provider <backend> --json
```

Read-only readiness does not prove allocation, setup, enrollment, or cleanup. Verify the complete session flow before relying on a new profile; see [Verify the profile](/gateway/cloud-workers#verify-the-profile).

## Configuration

Manage profiles in the Control UI under **Settings → Connections → Cloud workers**, or edit `cloudWorkers.profiles` directly in `openclaw.json` — both write the same config keys. The settings page lists each profile's backend, class, lifetime, and idle-stop in plain language, and shows whether it is advertised to `environments.list` or waiting on a Gateway restart. With no profiles configured it explains the feature, links back to this page, and starts the add flow.

**Machine class** is required in the class-based editor. Enter a class accepted by the selected Crabbox backend and binary; the provider determines its effective sizing. Changing the backend or binary leaves the class unchanged, so verify that it is accepted before saving. To configure a classless profile, use **Settings → Advanced** and omit `settings.class`; **Edit** on an existing classless profile opens Advanced. OpenClaw then omits `--class` unless the placement supplies a class, leaving resource selection to Crabbox without claiming a default size. Explicit `null`, empty or whitespace strings, and nonstring class values are invalid.

Add a profile under `cloudWorkers.profiles` in `openclaw.json`:

```json
{
  "cloudWorkers": {
    "profiles": {
      "aws": {
        "provider": "crabbox",
        "install": "bundle",
        "suspendAfter": "45m",
        "settings": {
          "provider": "aws",
          "class": "standard",
          "ttl": "8h",
          "idleTimeout": "45m",
          "warmImage": true,
          "setup": "test -x /usr/bin/node || (curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs)"
        }
      }
    }
  }
}
```

Profile fields:

| Key                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`           | Worker provider id registered by a plugin (`crabbox` for the bundled plugin).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `install`            | Installation preference for SSH-backed providers. The bundled Crabbox provider always installs the current Gateway bundle through the authenticated node channel.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `suspendAfter`       | Optional idle duration, such as `45m`, `90m`, or `2h`; minimum `1m`. Automatically suspend an idle worker using the same safe stop as manual reclaim. The next message provisions a replacement, warm when a snapshot exists. While suspended, only retained snapshot storage is billed; omit this field to keep workers running until explicitly stopped.                                                                                                                                                                                                                |
| `settings`           | Provider-owned JSON. For crabbox: `provider` (backend), `class` (machine class), `ttl`, `idleTimeout` (Go durations), optional idempotent `setup`, optional `desktop`, and absolute `binary` path. While a session remains placed, OpenClaw heartbeats its lease at a safe fraction of `idleTimeout`; teardown stops the heartbeat before releasing the machine. `desktop: true` asks Crabbox to warm the lease with its browser and loopback RFB desktop before node enrollment.                                                                                         |
| `settings.warmImage` | Optional. Saves a reusable machine image when an enrolled worker stops and starts later workers with the same profile from that image, so repeat sessions skip cold provisioning. Enabled by default when a configured or placement class is known and `setupEnv` is empty or omitted; set `true` or `false` to choose explicitly. Pair it with `suspendAfter` so suspended sessions wake warm. Images incur snapshot storage charges in your provider account. See [Warm images](/gateway/cloud-workers#warm-images) for capture boundaries, refresh, and prerequisites. |

### Warm images

Warm images are on by default when a class is known from `settings.class` or the placement's `machineClass`, unless the profile declares a nonempty `setupEnv`. With no effective class and no explicit `warmImage`, provisioning stays cold without requiring `warmImage: false`. Placement overrides are resolved before choosing this default.

Forwarded host environment values reach setup, so whatever setup derives from them could persist in a shared image. Profiles with nonempty `setupEnv` capture only when you explicitly set `settings.warmImage: true`, after checking that setup leaves no credential on disk. Explicit `true` requires a known configured or placement class before any provider command. Explicit `false` always keeps provisioning cold, for example when snapshot storage charges or provider-side retention of repository content are unwanted.

Warm images work on `machine0` through Crabbox's `--strategy image`; other backends keep their native checkpoint strategy. Images refresh automatically at the next eligible worker stop once they are 24 hours old, keeping captured caches current. After recording the replacement, OpenClaw deletes the superseded checkpoint on a best-effort basis. A deletion failure warns and leaves cleanup to Crabbox's `checkpoint prune`. OpenClaw also retains its 14-day cleanup for unused images. A failed refresh preserves the previous image for later forks.

Before capture, OpenClaw removes per-lease worker identities, device tokens, and session state, including node-host workspaces and SSH-transport workspaces under `~/.openclaw-worker/workspaces`. Machine-level caches intentionally survive: npm caches, content-addressed worker bundle installs under `~/.openclaw-worker`, and per-repository Git seeds under `~/.openclaw-worker/git-seeds`. A seed is a pristine post-sync repository copy, not a session snapshot. Images also retain whatever `settings.setup` wrote elsewhere, so keep setup credential-free and enable reuse only for mutually trusted workloads.

Scrubbing has a three-minute timeout. Checkpoint creation has a separate three-minute timeout, extended to ten minutes on `machine0` because image capture stops the source and waits for image availability even with `--wait=false`. Capture failure does not prevent teardown; without a usable image, later workers provision cold. Capture needs a Crabbox release with fixed-ID checkpoint forks, and coordinator-brokered leases additionally need `broker.adminToken`; without either, capture degrades to cold-only provisioning with a warning.

Reuse is exact-class: a placement override does not reuse another class's image, and only successful node enrollment records the class used for later capture, including after a Gateway restart.

### Per-project default profiles

Use `cloudWorkers.projectProfiles` to select a default profile from a managed session worktree's `origin` remote. Keys use the normalized lowercase repository identity `host/owner/repo`, without a trailing `.git`:

```json5 validate=false
{
  cloudWorkers: {
    projectProfiles: {
      "github.com/acme/app": "aws",
    },
  },
}
```

An explicit `profileId` or `deviceId` in `sessions.dispatch` always wins. A target-less project-profile lookup requires `operator.admin`. Deleting a profile from the Cloud workers settings also removes project defaults that reference it. If a manually configured mapping names a profile that is not present in `cloudWorkers.profiles`, dispatch fails closed and names both the repository key and missing profile. A worktree with no `origin` or no matching mapping returns a typed `INVALID_REQUEST` without provisioning or falling back to another target.

The enrolled node stores its identity, durable device token, endpoint, worker bundles, and workspaces under an isolated per-lease state directory on the disposable box. Provision replay first adopts the fixed Crabbox lease, then either resumes that node state or reuses the still-pending setup credential. It never mints a second environment identity for the same operation.

OpenClaw derives one canonical `cbx_...` lease ID from the durable provision operation and passes it to `crabbox warmup --lease-id`; the deterministic slug is display metadata only. If warmup commits but its response is lost, Gateway reconciliation repeats the same fixed-ID operation and Crabbox returns or adopts only the exactly attested lease. Intent drift, terminal ID reuse, and ambiguous unverified resources fail closed without allocating a replacement.

An interrupted legacy dispatch may have allocated a random lease without recording its ID. OpenClaw cannot identify that allocation safely from the old operation alone. It refuses replay and slug adoption, retaining the unresolved allocation and cleanup record across restarts instead of treating the resource as gone. Identify and clean up any prior lease before starting a new dispatch; do not guess by slug. Automatic identification or settlement of the old record is not supported. Legacy records already marked failed are not reopened automatically.

### The setup command

`settings.setup` runs on the leased box after Crabbox reports it ready and before ephemeral node enrollment. It runs on **every** provision attempt, including replay after an interrupted dispatch, so it must be idempotent — guard installs with a `command -v`/`test -x` check as in the example. At minimum, the resulting machine needs Node.js and `npx`. If setup or enrollment fails, the provider stops the lease and the dispatch fails closed; no half-configured paid box is hidden behind terminal state.

The example profile above prepares OpenClaw worker turns only. To make the same profile Codex-ready, run the following on the Gateway host. It preserves the existing setup, captures the Gateway version, installs that exact OpenClaw release on each cloud node, and installs the matching Codex plugin through the trusted official npm path:

```bash
gateway_version="$(openclaw --version | awk '{print $2}')"
existing_setup="$(openclaw config get cloudWorkers.profiles.aws.settings.setup)"
openclaw config set cloudWorkers.profiles.aws.settings.setup \
  "${existing_setup}; sudo sh -c 'umask 022 && npm install -g openclaw@${gateway_version}' && openclaw plugins install npm:@openclaw/codex@${gateway_version} --pin --force"
```

The root shell scopes `umask 022` to the global install so the node user can read and execute the package. A restrictive inherited mask can otherwise leave a successful root install inaccessible to that user. Verify `openclaw --version` on the box as the same user that runs enrollment, without `sudo`; a root-only probe does not establish that enrollment can use it. Keep enrollment credentials and state private.

`--force` allows setup replay to converge when the plugin is already installed. After upgrading the Gateway, update both appended package versions to match it while preserving the rest of the setup. This recipe requires both exact versions to exist in the registry. For unreleased source builds, use a complete custom node package as described below; a standalone local plugin tarball does not carry official npm provenance.

### Build a complete custom node package

For a trusted source build, produce the node distribution from the same source revision as the Gateway. The canonical package builder can explicitly include source-owned plugins that the ordinary core package excludes:

```bash
source_sha="$(git rev-parse HEAD)"
node scripts/package-openclaw-for-docker.mjs \
  --bundle-plugin codex \
  --pnpm-pack \
  --allow-unreleased-changelog \
  --output-dir .artifacts/cloud-node \
  --output-name "openclaw-cloud-${source_sha}.tgz"
shasum -a 256 ".artifacts/cloud-node/openclaw-cloud-${source_sha}.tgz"
```

Run this in a clean, trusted checkout with dependencies installed. The builder compiles the runtime, includes the selected plugin's built entrypoints and import closure, and regenerates the installation inventory. It temporarily adds the plugin's exact runtime dependency pins to the distribution manifest, rejecting conflicting or unpinned dependencies, then restores the source manifest and inventory. Repeat `--bundle-plugin <id>` for additional source plugins. Without that option, the ordinary core package and external plugin publication contracts are unchanged.

Publish the resulting archive through your existing immutable artifact delivery path and make `settings.setup` verify its SHA-256 before installing it globally with normal npm lifecycle scripts enabled. Record both source SHA and archive digest: different unreleased builds can share a version. Do not copy a plugin into an installed release or substitute a standalone `npm-pack:` plugin archive for this distribution.

After verifying the downloaded archive, install it with the mask scoped to the root command, then verify the version as the enrollment user:

```bash
sudo sh -c 'umask 022 && npm install -g /tmp/openclaw-cloud.tgz'
openclaw --version
```

Use the path of your verified archive in place of `/tmp/openclaw-cloud.tgz`. Changing the install mask does not repair existing root-only parent directories; if an earlier install was inaccessible, correct access to that package and its parent directories before retrying enrollment.

Native dependencies are declared at the distribution root and installed for the target operating system and CPU; the archive does not copy the build host's plugin `node_modules`. Target installation still needs registry access and is not an offline dependency bundle. Verify each target architecture you deploy. Use `--skip-build` only when reusing a complete build from that same source revision with all selected plugin outputs present.

### Bundle installation

The setup bootstrap first reuses an installed `openclaw` binary when its version exactly matches the Gateway, then tries the exact `openclaw@<version>` registry package. For an unreleased source build, install the matching [complete custom node package](/gateway/cloud-workers#build-a-complete-custom-node-package) in `settings.setup`; the provider will select it before touching the registry. After the node connects and publishes its session-host inventory, the Gateway pushes one content-addressed worker bundle through the paired channel. The node verifies and publishes those exact bytes without installing the normal OpenClaw package dependency tree. A stale Gateway build retires the environment and reprovisions against the current bundle rather than downgrading the execution-context protocol.

Codex remote execution additionally requires `settings.setup` or the cloud image to install the exact official npm `@openclaw/codex` plugin matching the Gateway version, including its pinned platform-native `@openai/codex` dependency. An exact-version bundled plugin is also accepted. Enrollment preserves the plugin's official npm or bundled provenance in the node's isolated per-lease state; it does not install plugins from npm or accept an untrusted local plugin path. A missing, mismatched, or untrusted plugin fails before the node starts.

### Verify the profile

Validate before restarting the Gateway:

```bash
openclaw config validate --json
openclaw plugins inspect crabbox --runtime --json
```

Changes under `cloudWorkers.profiles` require a Gateway restart. The default `gateway.reload.mode: "hybrid"` watches the config and performs that restart automatically; with reload watching disabled, run `openclaw gateway restart`.

To use the same profile with Codex, enable the Codex plugin on the Gateway, prepare its exact trusted installation in the cloud profile or image, and explicitly add `codex.exec-server.stdio.v1` to `gateway.nodes.commands.allow`. Crabbox activates that prepared plugin inside the cloud node's isolated state only when a Codex session selects the profile. Persistent command enablement does not replace the separate critical allow-once approval required for each exec-server attempt.

After the Gateway is back, prove the profile is advertised and compare it with Crabbox's read-only lease inventory:

```bash
openclaw gateway call environments.list --params '{}'
crabbox list --provider aws --json
```

The `environments.list` response must include the configured id under `profiles`. `crabbox list` is non-mutating. By contrast, `crabbox warmup` provisions a lease, and `crabbox stop` or `crabbox release` tears one down; use those mutating commands only when you intend to create or destroy cloud resources.

Before relying on a new profile, authorize provider spend and test allocation, setup, node enrollment, a turn in the selected runtime, and a workspace edit reconciled back to the Gateway. Test cancellation and interrupted-dispatch replay against the same lease, then stop the session and verify teardown using Crabbox's provider-specific cleanup contract. Read-only readiness checks and mocked tests are not substitutes for this end-to-end verification.

## Dispatching a session

Administrators can run an authorized managed-worktree session on a configured cloud profile. Session ownership and participation checks are revalidated before placement lifecycle changes commit.

In the Control UI, open **New Session** and use the unified **Place** picker to choose both the working folder and a **Cloud · profile** destination. A cloud destination appears only when all four eligibility gates pass:

1. The connected operator has `operator.admin` scope.
2. `environments.list` advertises at least one configured profile.
3. The selected Gateway folder is a Git checkout that can use a managed worktree.
4. The selected agent runtime advertises cloud placement support.

Cloud selection enables that worktree automatically. The Gateway creates the session, finishes dispatch, and only then sends the first turn. The server badge in the session sidebar shows the durable placement state.

While a placement is active, OpenClaw automatically samples available space on the remote workspace volume. Low-space warnings appear in the selected chat and on the session's cloud badge. They are advisory, clear automatically after space recovers, and do not stop or reclaim the worker.

### Cloud child sessions

When an OpenClaw worker uses `sessions_spawn`, the Gateway creates a visible child session in a separate managed worktree, provisions a worker with the parent's profile, and submits the initial task before returning acceptance. The call does not wait for the child task to finish.

While that call is waiting, the parent remains an active turn under its existing run timeout. Quiet provisioning alone does not let a queued message take over the parent or make recovery abort it early. Worker progress does not extend the timeout, and the chat **Stop** control or `/stop` can still cancel the turn. Use **Stop cloud worker…** separately to reconcile the workspace and release the machine.

### Runtime support

- **OpenClaw** uses `worker-turn` placement. The restricted `openclaw worker` process runs each turn on the leased node and proxies inference through the Gateway.
- **Codex** uses `remote-exec` placement on the same bundled Crabbox cloud profile, an eligible paired device, or a provider that advertises an SSH-backed execution carrier. The Gateway keeps the Codex app-server and authentication local; an enrolled cloud node runs only the explicitly authorized Codex exec-server and does not start an OpenClaw worker child.

The Control UI checks each cloud destination's advertised execution modes in both New Session and Move Session. One Crabbox **Cloud · profile** row is selectable for OpenClaw and Codex, while a genuinely single-mode provider stays disabled for the other runtime. An incompatible move is rejected before the active source starts draining or changes its durable placement.

Other runtimes remain unavailable unless their harness explicitly declares a cloud placement mode. Cloud targets are not offered for external CLI session catalogs. Remote-exec fails closed if the selected provider or placement sandbox is unavailable; it never falls back to running the operation on the Gateway host.

### Codex on a paired device

Paired-device Codex placement requires the `codex` plugin to be installed and
enabled in both the Gateway's configuration and the node's own local
configuration. Include `codex` in `plugins.allow` on either machine when that
machine uses a plugin allowlist. It also requires a connected session-capable
node that advertises `codex.exec-server`, and an explicit
`gateway.nodes.commands.allow` entry for `codex.exec-server.stdio.v1`. Approve
the node's updated pairing surface if needed. Before each exec-server launch,
OpenClaw also requires the normal node invocation approval; denying that
request does not start a process.

Codex launches its exec-server directly, so paired-device and cloud-node placement do not consume an OpenClaw worker slot and remain eligible when those slots are full. OpenClaw `worker-turn` placement still requires an available worker slot.

Approval permits process execution and filesystem access anywhere the node's
operating system account allows. The exact placement workspace controls the
starting directory and reconciled changes, not OS-level confinement. Trust the
paired device, and use a separate least-privilege OS account when isolation is
required.

Choose the device in the Control UI **Place** picker or dispatch a
managed-worktree session with an authorized operator connection:

```bash
openclaw gateway call sessions.dispatch \
  --params '{"key":"agent:main:device-work","deviceId":"<paired-device-id>"}'
```

The Codex app-server, model connection, provider credentials, and transcript
remain on the Gateway. The paired node runs the managed Codex exec-server in
the transferred workspace and receives only sanitized process, filesystem,
capability-discovery, and HTTP operations over the existing node channel. It
does not launch an OpenClaw worker child. Credential-bearing HTTP requests are
rejected before they reach the paired device; run authenticated requests on the
Gateway or use an intentionally credential-free endpoint. Normal Codex turns
are supported, but `/btw` side questions are not yet placement-bound and fail
visibly. Completed changes return through the same placement workspace
reconciliation as worker turns. See
[Run Codex on a paired device](/plugins/codex-harness#run-codex-on-a-paired-device)
for the exact allowlist configuration and lifecycle.

### Codex or OpenClaw on a cloud profile

The same configured Crabbox profile can host either harness. Select its **Cloud · profile** row after choosing an OpenClaw or Codex model; the selected runtime determines whether provisioning prepares a worker child or the managed Codex exec-server. Codex cloud-node execution requires the same explicit Gateway command allowlist and per-attempt allow-once approval as paired-device execution. It never falls back to Gateway-local or SSH execution if the node command is missing, denied, or disconnected.

For cloud-profile placement, the equivalent RPC flow is:

Create a session with a managed worktree, then dispatch it. Profile dispatch requires `operator.admin` and is available only while at least one worker profile is configured:

```bash
openclaw gateway call sessions.create \
  --params '{"key":"agent:main:big-refactor","worktree":true,"cwd":"/path/to/repo","worktreeName":"big-refactor"}'

openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","profileId":"aws"}'
```

### Choose a machine class per session

A worker profile's `settings.class`, when configured, remains its default. In the Control UI, selecting a **Cloud · profile** destination in the Place picker reveals a machine section listing the profile's advertised classes, with reported vCPU and RAM when available and the default marked; picking one updates the place chip (for example `hetzner · Fast`) and carries the choice into dispatch. To choose a different size for one new placement over RPC instead, pass `machineClass` with `profileId`:

```bash
openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","profileId":"aws","machineClass":"large"}'
```

The bundled Crabbox provider reads `classCatalog.profiles` from `crabbox providers --json` for the selected backend when `classCatalog.disposition` is `mapped`. It uses Linux/amd64 primary profiles, preserving their order and marking the configured class as the default; other targets, architectures, and fallback machines are not merged into these choices. The picker includes at most 32 options; it appends the configured class only when a usable advertised list exists. A classless profile retains all advertised choices up to that limit, with no invented default or reserved default slot. Reported vCPU and RAM appear independently. RAM follows Crabbox's summary contract: positive integer GB/GiB values are shown; other units, fractional values, and missing dimensions stay unknown. Native type names are never used to guess dimensions. Unmapped, missing, unknown, failed, empty, or unusable catalog metadata produces no machine selector, even if legacy `classes` are present. The cloud profile remains selectable, and dispatch or Move without an override preserves its configuration.

Successful catalogs, including valid empty catalogs, are cached for the Gateway lifetime. Failed probes are retried by the next discovery request; a Gateway restart is not needed to recover.

Mapped Machine0 classes appear even when Crabbox omits the legacy `classes` summary. These static mappings describe class choices, not current capacity or availability. OpenClaw does not translate provider-native size catalogs into classes. Keep native size selection in Crabbox's configuration: an explicitly configured native size still takes precedence over a class, so the picker cannot override that pin or promise a resize. Acceptance of native server types through `machineClass` is backend-specific, not a universal Crabbox contract. An admitted machine choice remains fixed for that placement and is reused by provisioning retries; catalog changes do not rewrite it. `machineClass` is valid only with `profileId`, not `deviceId`.

`sessions.dispatch` closes local turn admission, drains active work, validates the eligible Git workspace inventory, provisions the lease for the selected execution mode, runs setup, enrolls the node, pushes the required pinned Gateway bundle, syncs the workspace, and returns once the placement reaches `active` ownership. Inventory validation happens before provider allocation and reports an invalid request with an actionable size or entry limit when the workspace cannot be dispatched. Budget several minutes for the first cloud dispatch; leases and content-addressed bundles are reused where safe. After that, talk to the session as usual. OpenClaw turns route to the worker process; Codex native operations run on the authorized cloud node, paired device, or supported SSH-backed provider.

The workspace is not a continuous mirror: OpenClaw syncs a fresh eligible inventory at dispatch, not before every turn on an existing worker. In Git workspaces, files created only on the Gateway after dispatch remain local and outside the accepted manifest. To send those new inputs, finish the current turn, stop the cloud worker, and dispatch again.

Completed cloud turns reconcile eligible, size-bounded workspace files back into the session's managed worktree before the turn claim is released. Worker-turn uses its terminal worker event to create the durable pending-result fence. Remote-exec waits for workspace quiescence and enters the same reconciliation flow after the local Codex attempt. Before applying the result, the Gateway stages complete authenticated base/current manifests plus each changed resulting blob as a Git ref under `refs/openclaw/worker-results/`; deletions are represented by the manifests and need no blob. This keeps the cloud delta recoverable even if the Gateway stops during the apply without duplicating unchanged baseline content. Workspace results use Git file semantics: regular files, executable bits, symlinks, additions, changes, and deletions are retained, while empty directories and other directory modes are not. The resulting file changes remain in the managed worktree for normal review and commit.

To publish the finished work, the agent calls `github_publish` as its final action and then completes the turn. The call records only a single-line title, body, and idempotency key. After reconciliation is durably accepted, but before the exact turn claim is released, the Gateway re-resolves the session-owned managed worktree and effective GitHub identity. It uses the title as the commit subject, appends deterministic verified participant trailers, pushes the authoritative branch through an exact HTTPS path, and creates or reuses a draft pull request. The terminal transcript entry contains either the pull request URL or a typed failure with the next action. A restart resumes from the accepted workspace-result fence and remote branch or pull-request evidence; it never gives the recovered worker new forge authority.

Apply uses the latest accepted manifest as the merge base, initialized at dispatch and advanced after each accepted reconciliation. Cloud-only changes are applied, local-only changes stay in place, and paths changed on both sides use a three-way keep-local policy. A conflicted turn still finishes: the transcript reports the bounded path summary and staged result ref, the placement exposes the same conflict for the Control UI, and non-conflicting cloud changes remain applied. The notice includes `git show <ref>:<path>` to inspect a present cloud file and a top-level literal-pathspec `git checkout <ref> -- <path>` command to take it from any workspace directory. Run the commands in Bash or zsh (Git Bash on Windows). If inspect says the path does not exist, the cloud result deleted it; verify and remove the retained local path manually. If checkout reports a file/directory obstruction, move or remove the blocking local path and retry. If the staged ref itself is gone, treat the notice as stale and do not change the local path. Conflicted staged refs remain available after the normal turn fence is released; a later clean result clears the notice and retires the old ref, while explicit fence removal is the final cleanup boundary.

While a fenced result is still reconciling, a new turn waits up to 15 seconds for the prior claim to release. If it is still busy, the turn fails with an actionable “previous cloud turn's workspace result is still reconciling” message and can be retried shortly. On restart, recovery discovers pending and staged results before stale-claim cleanup, completes or retries their local apply, and reclaims dead environments only after preserving the result. The bounded SQLite rollback journal makes an interrupted filesystem apply recoverable without replaying already accepted mutations.

To continue the same session somewhere else, open the **Runs on Cloud** chip and choose **Move session…**. An operator with `operator.write` can select the Gateway or an eligible paired device; selecting a configured cloud profile requires `operator.admin`. Profiles may also offer a machine class. Moving to the current profile with a different effective class replaces its worker; it is not an in-place resize, and native size overrides may take precedence over classes. The Gateway closes new admission, interrupts any active turn, reconciles the source workspace, destroys the old environment, and then activates the destination. An interrupted turn is never replayed: partial output may disappear, and you send the next turn again after the move. The exact target, including a machine override, and bounded errors are durable, so the Control UI shows **Moving to…** or the recovery error after a reconnect. If the Gateway restarts before the destination becomes active, request-bound authority is lost: recovery finishes safe source cleanup, marks the placement failed with a retry message, and does not provision the destination. Reconnect, then choose **Move session…** again.

An active paired-device placement stays `active` when its runner disconnects.
Control UI shows **Device offline** and **Waiting for device to reconnect; retry
after it returns**. Waiting is the default and keeps the remote owner and
workspace intact. Any in-flight Codex `remote-exec` attempt fails visibly, its
node exec-server and child processes are terminated, and reconnecting the same
paired device allows a fresh attempt only; the disconnected stdio session is
never resumed. **Continue on Gateway…** is explicitly destructive: after a
data-loss confirmation, it abandons the exact offline device owner and resumes
from the last Gateway-synced workspace without replay. Unsynced device files
and in-flight work may be lost. This explicit abandonment also fences an active
local Codex turn claim without waiting for an acknowledgment from the offline
node. If the device is already available, use the
ordinary reconcile-first move instead.

When the work is complete and no turn is running, choose **Stop cloud worker…** from the same chip. The Gateway performs one final workspace reconciliation before it destroys the environment. A placement already in `draining` or `reconciling` is finishing teardown; wait for its badge to become `reclaimed` before resetting or deleting the session. Starting another turn after reclaim provisions a replacement worker only while its original cloud profile remains configured for the same provider; deleting that profile prevents new cloud allocation.

Archiving or deleting a non-main cloud-worker session with an active placement first interrupts and drains its current work, then safely reclaims the worker. The Gateway records the archive or deletion only after final reconciliation and safe teardown succeed. If reclaim is unavailable, fails, or the placement is transitioning or failed without proof that its environment is gone, the operation reports an error and retains the session and recovery state; it never force-discards unsynced work. Restoring an archived session retains reclaimed placement metadata so the next turn can dispatch a fresh worker with the same workspace profile.

For a broken or runaway cloud environment, an administrator can call the admin-only `environments.destroy` method with `{ "force": true }` as a last resort. Forced teardown durably marks the placement failed and abandons any unreconciled remote result before destroying the environment.

The equivalent write-scoped session RPC is:

```bash
openclaw gateway call sessions.reclaim \
  --timeout 600000 \
  --params '{"key":"agent:main:big-refactor"}'
```

The result placement is `reclaimed` after an active worker is safely stopped. Reclaim also waits for an in-flight dispatch and retries pending teardown for a failed placement before returning `local`. No other placement states are successful reclaim results.

If provider teardown fails or times out during stop or move, the request reports that failure even if recovery subsequently finishes cleanup. Check the current placement before retrying. A dedicated cloud worker can remain recorded as attached while destruction is uncertain, but its closed authority cannot resume remote workspace processes.

An ended or unusable provider lease is not proof that its machine was deleted. OpenClaw fences that worker, stops renewing the lease, and requests explicit provider teardown. Failed teardown stays retryable; a missing local claim or an earlier “not found” warning does not turn a failed stop into success.

For automation, read the active placement's `generation`, `environmentId`, and `activeOwnerEpoch` from `sessions.describe`, then supply those exact source facts to `sessions.move`:

```bash
openclaw gateway call sessions.move \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","expected":{"generation":5,"environmentId":"worker:source","ownerEpoch":2},"target":{"kind":"gateway"}}'
```

Worker targets use `{"kind":"profile","profileId":"aws","machineClass":"fast"}` or `{"kind":"device","deviceId":"paired-device-id"}`. Omit `machineClass` to use the profile default. Moving to the same profile with a different class is the resize workflow. A stale source is rejected rather than moving a newer placement. Successful results end in `local` for the Gateway target or `active` for a worker target.

Automation may explicitly abandon an offline paired-device source by adding
`"abandonSource":true` to the exact-source Gateway request above. The field is
rejected for profile or device targets and when the source runner is available
or cannot be proven to be the exact device binding. This path has the same
unsynced-file and in-flight-work loss boundary as the Control UI confirmation.

Placement moves through a durable state machine (`local → requested → provisioning → syncing → starting → active`), so a Gateway restart mid-dispatch reconciles instead of leaking machines. A failed model turn keeps the active placement available for a retry. Workspace path conflicts keep the local version, apply the rest of the cloud result, and preserve the staged cloud ref for inspection; other reconciliation or lifecycle failures retain their durable recovery fence and diagnostic tail until recovery can safely retry or reclaim the environment.

If a turn reports `Cloud worker finished, but its workspace result could not be reconciled`, inspect the cause after the colon. A failed node manifest capture includes its bounded, redacted stderr, or its termination status when stderr is empty. Node cleanup preserves manifests needed between upload and verification, including when other workers finish simultaneously; increasing transfer timeouts does not repair a missing manifest.

## What survives a dead machine

The Gateway owns the canonical session transcript in both modes. Worker-turn commits each complete user, assistant, and tool-result message before the worker's session write settles; remote-exec uses the normal local harness transcript path because the Codex app-server stays on the Gateway. If the machine disappears mid-message, durable history ends at the last committed message. Partial text or tool progress already shown by the live stream may disappear; the failed turn remains visible, and the failed placement records a bounded terminal reason above the composer.

Worker-turn live previews are snapshots of the current assistant message. Corrections, shorter previews, and empty replacements update that message without replaying or erasing earlier messages in the turn. Explicit commentary is kept out of answer text, including when its phase arrives at message completion. Live previews are bounded and can be dropped after stream degradation; the committed transcript remains authoritative.

Workspace state has a wider loss window. A completed turn reconciles cloud files before releasing its claim, and **Stop cloud worker…**, archiving, or deleting a session performs final reconciliation before destroying an active worker. Changes made between reconciliations exist only on the box and can be lost if that box disappears. Deletion proceeds only after safe reclaim succeeds, then snapshots the reconciled managed worktree under `refs/openclaw/snapshots/` before removing it. A failed safe reclaim retains the session and unsynced recovery state and reports an error.

After a failed placement, redispatch the session and retry the turn. A reclaimed placement redispatches automatically on the next turn. The next turn rebuilds model context from the Gateway transcript, so it continues from the messages that crossed the durability boundary.

## Desktop (interactive)

Cloud Worker Desktop lets an administrator watch or control a capable worker from the Control UI without exposing its cloud node as an ordinary paired node. Enable the **Cloud Worker Desktop** lab, then set `settings.desktop: true` on a Crabbox profile. Desktop capability is fixed at warm time: changing the setting affects newly provisioned workers, while an existing non-desktop lease must be stopped and reprovisioned.

The bundled Crabbox plugin supports direct AWS profiles. Coordinator-backed AWS and Hetzner profiles are supported when the selected coordinator advertises Desktop and Browser capability. OpenClaw keeps worker execution node-only: `openclaw worker`, workspace transfer, desktop observation, and app launch all use the authenticated outbound node connection. It does not restore SSH execution, a reverse tunnel, or rsync. Direct Hetzner rejects OpenClaw's fixed lease ID, so desktop profiles fail before allocation unless Hetzner uses a capable managed coordinator.

Crabbox provisions XFCE on display `:99`, an authenticated RFB server on `127.0.0.1:5900`, a fresh lease-scoped browser profile with CDP on `127.0.0.1:9222`, and fixed zero-argument Browser and Terminal launchers. The provider also installs an OpenClaw worker wallpaper so the disposable desktop is easy to identify. Setup is idempotent and runs before node enrollment on every provisioning replay.

The desktop never gains public ingress. The node reads `/var/lib/crabbox/vnc.password` locally, probes the authenticated loopback RFB server, and redeems a single-use Gateway broker ticket over the node's already-connected origin. TLS deployments pin the same Gateway certificate used by the node connection. The Gateway revalidates the durable environment, lease, node, owner epoch, desktop descriptor, connection, and pairing both before dispatch and after attach; drain, replacement, or teardown aborts the stream and any pending app launch. The shared desktop session owner performs RFB preauthentication, view-only input filtering, and single-controller arbitration.

## Security model

- **Closed worker ingress.** In worker-turn mode, the enrolled node launches the worker child, which dials the Gateway's authenticated public worker route and speaks a dedicated protocol with a closed method allowlist — a worker cannot call operator RPCs.
- **Gateway-owned tool authority.** In worker-turn mode, the Gateway projects current profile, provider, agent, group, sender, sandbox, delegation, inherited, and runtime-cap policy over the worker's fixed coding-tool catalog before every turn. The launch envelope carries only that final closed-vocabulary subset. Explicitly capped scheduled turns reuse their trusted owner-group context without sending that identity to the box or reapplying a fresh sender overlay. Tools outside the worker catalog remain unavailable; an empty result runs with no tools.
- **Minted credentials, hashed at rest.** Each dispatch mints a worker credential; the Gateway stores only its hash. Credential rotation and owner-epoch fencing guarantee at most one live owner per session — a stale worker that reconnects is fenced, never merged.
- **Environment-bound enrollment.** One short-lived node-only setup credential is bound to the durable environment before allocation. Its first authenticated Ed25519 device identity is recorded atomically with setup completion; replay cannot substitute an unrelated node.
- **Explicit Codex node authorization.** Cloud-node and paired-device remote execution require an explicitly allowed `codex.exec-server.stdio.v1` command, an approved pairing surface, and critical node invocation approval for each attempt. The managed exec-server starts with a fresh private home and sanitized environment; allow-once never grants a later launch. Its managed workspace is not an OS sandbox: approved execution can access processes and files allowed to the node account, so use a separate least-privilege account when isolation is required.
- **No standing model, forge, or cloud credentials on the box.** OpenClaw worker turns proxy inference by `{provider, model}` reference. Codex remote-exec keeps the app-server plus ChatGPT subscription or API-key auth on the Gateway and sends only sandbox operations to the box. Remote-exec requires prepared auth and rejects ambient auth fallback. Workspace git commits are authored without forge credentials, and Crabbox AWS lease metadata is checked authoritatively for an instance role before setup. Keep setup commands credential-free too.
- **Gateway-owned GitHub publication.** Publication credentials stay in the effective managed or native GitHub profile on the Gateway. The broker disables repository hooks, refuses configured Git clean filters, uses a temporary index and `git commit-tree`, pushes only a reconstructed public HTTPS URL with a command-local `gh auth git-credential` helper, and never writes a bearer token to argv, a remote URL, `.git/config`, a worker payload, or a transcript.
- **Provider-owned egress.** Gateway-proxied inference removes any OpenClaw need for direct model access, but OpenClaw does not rewrite provider firewalls. Restrict outbound traffic in the worker provider when the task requires it.
- **Durable, exactly-once worker transcripts.** In worker-turn mode, the worker commits transcript batches through a compare-and-swap protocol against the session's leaf; a stale base fail-stops the run instead of duplicating or rebasing paid output. Remote-exec writes through the Gateway's normal local harness path.

## Troubleshooting

- **No cloud profile is advertised** — run the `operator.read`-scoped `openclaw gateway call environments.list --params '{}'`. If the response has no `profiles`, ask an administrator to validate `cloudWorkers.profiles`, inspect the provider plugin, and restart the Gateway. This is a configuration or provider-activation problem, not an authorization result.
- **Cloud destinations are hidden or an RPC is denied** — cloud profile dispatch and profile-target moves require `operator.admin`. `operator.write` can dispatch or move to an eligible paired device, move to the Gateway, and reclaim a placement; `operator.read` alone can discover profiles but cannot start, stop, or move a session. Profile configuration, infrastructure pairing, Connect machine, raw environment lifecycle, direct `execNode` execution, incognito sessions, and arbitrary host or node paths remain `operator.admin`.
- **The selected runtime lacks cloud placement support** — choose a model whose advertised runtime supports cloud placement. The bundled OpenClaw and Codex runtimes are supported; undeclared runtimes remain local-only.
- **Codex cannot use a cloud profile** — verify that the profile advertises `remote-exec`, its setup installs the exact official `npm:@openclaw/codex@<gateway-version>` plugin, the Gateway enables the Codex plugin, and `gateway.nodes.commands.allow` includes `codex.exec-server.stdio.v1` without a matching deny rule. Approve the exact node invocation when prompted. Codex does not require an available OpenClaw worker slot; a missing plugin or denied command must be corrected rather than bypassed with Gateway or SSH execution.
- **The portal tool is unavailable on a worker** — confirm the session uses OpenClaw `worker-turn` on an enrolled node that advertises portal-stream support. Update older node bundles when necessary. SSH-backed `remote-exec` placements, including Codex sessions, do not run the OpenClaw worker tool loop; move the session back to the Gateway with `sessions.move` when a Gateway-hosted portal is needed.
- **"Worker bootstrap requires Node.js on the leased host"** — add a Node install to `settings.setup` (see above).
- **AWS instance-role attestation fails** — clear `aws.instanceProfile` (and `CRABBOX_AWS_INSTANCE_PROFILE`, if set). Install Crabbox 0.41.1 or newer; older binaries do not satisfy the fixed-ID and authoritative `providerMetadata.instanceProfileAttached` contracts required for AWS admission.
- **Dispatch or workspace recovery fails** — inspect `environments.list` and `sessions.describe`. A failed environment exposes its bounded environment error. A failed placement exposes `recoveryError` plus its durable per-session `terminalReason`; the selected Control UI chat shows that terminal reason above the composer. When deeper diagnosis is necessary, an operator on the Gateway host can inspect the durable worker state read-only. Do not edit the state database to bypass lifecycle fencing.
- **Crabbox setup cannot reach the lease** — check the selected backend's networking and setup-transport requirements in the [Crabbox provider reference](https://crabbox.sh/providers/index.html). Correct Crabbox's configuration and rerun `crabbox doctor --provider <backend> --json` before retrying.
- **Session shows a reclaimed or suspended badge after being idle** — this is expected when its profile sets `suspendAfter`. The next message provisions a replacement worker, warm when an image exists.
- **A warm image was stale or missing** — dispatch falls back to normal cold provisioning automatically. This is expected behavior and does not require a retry.
- **Node enrollment times out** — inspect the package selection, node process state, and bounded node-log tail included in the enrollment error. Verify that profile setup installed Node.js and `npx` and that the box can reach the Gateway's advertised TLS URL and public worker/node WebSocket route. If the error contains `proxy_attribution_required`, add the reverse proxy's source address to `gateway.trustedProxies`.
- **Client timeout while dispatching** — `openclaw gateway call` defaults to a 10s timeout; pass `--timeout` generously. Dispatch keeps running server-side either way, and an identical retry on the same Gateway joins that in-flight operation instead of provisioning another worker. A retry with a different profile or session identity is rejected.
- **Provider authorization fails after `doctor` passes** — read-only readiness does not prove permission to allocate or tear down a lease. Inspect the denied action and follow the selected provider's provisioning and cleanup requirements in the [Crabbox provider reference](https://crabbox.sh/providers/index.html).
- **Worker reclaimed after upgrading from a 2026.7.2 beta** — those betas used the older worker launch contract. On restart, OpenClaw destroys an idle incompatible worker, keeps the session and workspace, marks the placement reclaimed, and provisions a current worker on the next dispatch or turn. A beta worker interrupted while still starting is marked failed after cleanup; retry the dispatch to provision it with the current contract.
- **Cloud workspace conflict notice** — the turn completed and kept the local version of each listed path. Use the staged-ref commands in the notice to inspect or take the cloud version; no retry is required for the non-conflicting changes, which are already applied.
- **Cloud session disk-space warning** — delete unneeded files from the remote workspace or stop the cloud worker before large writes. The warning clears automatically after the next successful sample shows enough free space; a failed sample leaves the last successful warning visible and does not affect the session lifecycle.
- **“The previous cloud turn's workspace result is still reconciling”** — the Gateway waited briefly for the prior result's durable fence and could not acquire the session claim. Wait for reconciliation to finish, then retry the turn; restarting the Gateway is safe because recovery preserves staged results before reclaiming a dead worker.
- **GitHub publication failed** — open **Agents → Tools → GitHub Identity** and confirm the effective `@login`, selected scope, access expiry, and refresh state. Reconnect GitHub when refresh is expired or unavailable; use a managed PAT only as the explicit fallback. For push rejection, inspect repository write access and branch drift; `/user` verification does not prove repository write access and the broker never force-pushes. For pull request rejection, grant pull-request write access and call `github_publish` again with a new tool call.
- **Lease housekeeping** — `crabbox list --provider <backend> --json` is a read-only inventory. `crabbox stop --provider <backend> --id <lease>` and `crabbox release --provider <backend> --id <lease>` are destructive and release a lease manually. OpenClaw keeps the lease alive while its session is placed, then stops heartbeating during teardown so genuinely idle leases expire on the profile's `idleTimeout`. Crabbox 0.43.0 and older do not expose the heartbeat command; OpenClaw warns once per environment and cannot prevent coordinator-idle reaping on those binaries.

## Related

- [Sandboxing](/gateway/sandboxing) — reducing blast radius for local tool execution
- [Sessions CLI](/cli/sessions) — inspecting stored sessions
- [Configuration reference](/gateway/configuration-reference)
