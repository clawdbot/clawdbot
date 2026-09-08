---
summary: "Cloud worker profiles under cloudWorkers, including Crabbox and static SSH development"
read_when:
  - Defining a cloud worker environment
  - Configuring the Crabbox profile
  - Setting up a static SSH development worker
title: "Configuration — cloud worker environments"
---

Cloud worker environment keys under `cloudWorkers.*`.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## Cloud worker environments

Cloud workers are opt-in. If `cloudWorkers` is absent, or `profiles` is empty, OpenClaw accepts no new cloud-worker creation and does not advertise a Cloud destination. `sessions.dispatch` may remain available for eligible paired-device targets. The config schema and read-only `environments.list` and `environments.status` methods remain available. Durable records created earlier still reconcile and remain visible; the existing gateway/node projection is unchanged.

SSH-backed `remote-exec` providers must return a trusted `hostKey` as exactly `algorithm base64`, without a hostname or comment. Bootstrap writes that key to an isolated `known_hosts` file, uses `StrictHostKeyChecking=yes`, and fails before opening a connection when the provider omits it. There is no trust-on-first-use fallback. These providers also carry workspace traffic over separate pinned SSH connections so rsync cannot block control traffic.

Node-backed providers return an authenticated node device id for either `worker-turn` or `remote-exec`. The Gateway installs the current pinned bundle and transfers the workspace through the node transport; these leases do not return or resolve OpenClaw SSH endpoint credentials. `worker-turn` requires a node lease and launches a restricted OpenClaw worker child. `remote-exec` can use either an enrolled node or an existing SSH-backed provider and keeps the harness plus model authentication on the Gateway.

### Crabbox profile

The bundled `crabbox` provider provisions a disposable machine through the local Crabbox CLI, enrolls it as an ephemeral outbound node, and returns the same node transport for OpenClaw `worker-turn` or Codex `remote-exec`. One configured profile can therefore be selected by both harnesses; the selected session runtime determines its execution semantics. The inner `settings.provider` selects the Crabbox backend; it is separate from the outer OpenClaw provider id.

```json5
{
  gateway: {
    nodes: {
      commands: {
        // Required only when this profile also runs Codex remote-exec sessions.
        allow: ["codex.exec-server.stdio.v1"],
      },
    },
  },
  cloudWorkers: {
    profiles: {
      production: {
        provider: "crabbox",
        suspendAfter: "45m",
        settings: {
          provider: "aws",
          class: "standard",
          ttl: "24h",
          idleTimeout: "60m",
          // Optional absolute path. Default: sibling ../crabbox/bin/crabbox, then PATH.
          binary: "/usr/local/bin/crabbox",
        },
      },
    },
  },
}
```

- `settings.provider` (required): backend from the [Crabbox provider reference](https://crabbox.sh/providers/index.html), passed through `--provider`. Direct or coordinator-backed operation follows Crabbox's configuration.
- `settings.class`: optional Crabbox machine class passed to `--class`. Omission leaves selection to Crabbox unless the placement supplies `machineClass`; OpenClaw does not invent a default or hardware size. Explicit `null`, empty or whitespace strings, and nonstring values are invalid. Edit classless profiles through **Settings → Advanced**.
- `settings.ttl` and `settings.idleTimeout` (required): positive Go duration strings passed to `--ttl` and `--idle-timeout` as provider-side failsafes.
- `settings.warmImage`: prepares a project's committed checkout and node runtime for capture before enrollment, then starts later workers for that project and profile from the image. Without a prepared Git project, capture remains at eligible worker teardown. Pair with `suspendAfter` so suspended sessions can wake warm. Enabled by default when a configured or placement class is known and `setupEnv` is empty or omitted. Without an effective class, omission stays cold. A nonempty `setupEnv` keeps the default cold because forwarded host environment could leave setup-derived credentials in a shared image. Explicit `true` opts in but requires a known effective class before provider commands; explicit `false` always stays cold. The resolved class and original cold/checkpoint choice are recorded before allocation and remain fixed through retries and restart. Images incur provider snapshot storage charges and retain machine-level caches, including pristine Git seeds, alongside whatever `setup` wrote outside scrubbed worker state. Scrubbing has a three-minute timeout; checkpoint creation has a separate three-minute timeout, ten on `machine0`. An uncertain project capture blocks enrollment on its source but still permits lease cleanup. See [Warm images](/gateway/cloud-workers#warm-images) for refresh, retention, and Doctor migration and recovery.
- `settings.binary`: optional absolute Crabbox executable path. Without it, OpenClaw checks the sibling Crabbox checkout, then executable entries on `PATH`, and finally invokes `crabbox` so a missing CLI remains a visible provider error.

Unknown settings are rejected. Crabbox credentials and backend-specific account configuration remain owned by Crabbox; do not place them in `settings`. OpenClaw invokes only the local CLI and makes no provider network calls from this plugin. Provisioning passes one deterministic canonical lease ID through `--lease-id`, keeps `--slug` as display metadata only, and always passes `--keep=true`; OpenClaw owns the external lifecycle and destroys the lease with `crabbox stop --id <canonical-id>`. After an ambiguous result, Gateway reconciliation repeats the same fixed-ID operation. Crabbox must return the exactly attested lease or fail closed; OpenClaw never falls back to slug adoption or replacement allocation.

Provider support and backend-specific setup belong to [Crabbox](https://crabbox.sh/providers/index.html). Configure credentials, coordinator access, networking, and snapshots there rather than duplicating them in OpenClaw settings. The installed backend must satisfy OpenClaw's [cloud-worker lifecycle requirements](/gateway/cloud-workers#crabbox-provider-support).

Crabbox setup uses an environment-owned one-use pairing credential and the configured public Gateway URL. The provider returns the exact authenticated node id; the Gateway then installs its current bundle and transfers the workspace through authenticated node routes. For Codex remote execution, Crabbox prepares the bundled Codex plugin and pinned managed binary in the node's private state, and the Gateway requires the explicitly allowed `codex.exec-server.stdio.v1` command plus critical allow-once approval for each attempt. No OpenClaw worker child or worker slot is used in that mode. OpenClaw does not persist Crabbox SSH endpoint, key, host-key, or fallback-port output.

<Note>
  AWS admission requires `providerMetadata.instanceProfileAttached` to be false. Install Crabbox 0.41.1 or newer for the fixed-ID replay and closed inspection contracts.
</Note>

### Static SSH development profile

```json5
{
  cloudWorkers: {
    profiles: {
      development: {
        provider: "static-ssh",
        settings: {
          host: "worker.example.test",
          port: 22,
          user: "openclaw",
          hostKey: "ssh-ed25519 <base64-public-host-key>",
          keyRef: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_WORKER_SSH_KEY",
          },
        },
      },
    },
  },
}
```

- `profiles`: named worker profiles with non-empty, whitespace-trimmed ids. Each profile selects a provider registered by a plugin.
- `provider`: non-empty worker provider id. The examples use the bundled `crabbox` provider and the QA Lab `static-ssh` provider.
- `install`: SSH-backed `remote-exec` worker installation method. `"bundle"` (default) transfers a content-hashed bundle of the gateway's installed build and supports released, development, and unreleased versions. `"npm"` is an opt-in optimization for an unmodified packaged release; it installs `openclaw@<exact gateway version>` from the public npm registry and never installs `latest`. Node-backed `worker-turn` and `remote-exec` providers install the pinned Gateway bundle through node transport instead.
- `suspendAfter`: optional profile-level duration such as `45m`, `90m`, or `2h`; minimum `1m`. The Gateway safely reclaims the worker after its session stays idle for this long. The next message provisions a replacement, warm when an image exists. Omit this field to keep workers running until explicitly stopped.
- Bundled provider plugins are selected automatically when configured, but explicit disables and `plugins.allow` still apply. Include the provider id (for example, `crabbox`) when an allowlist is configured. External provider plugins must also be installed and explicitly enabled.
- `settings`: provider-owned bounded JSON. The selected plugin defines and validates its keys; use [SecretRef objects](/gateway/secrets) for secret-bearing values. The static SSH provider requires `host`, `user`, `hostKey`, and `keyRef`; `port` defaults to `22`. `hostKey` must be one OpenSSH public host-key line (`algorithm base64`) obtained from the known host or another trusted channel, with no options prefix.

A supported Node runtime (22.22.3+, 24.15+, or 25.9+) with WAL-reset-safe SQLite must already be installed on the worker. The opt-in `"npm"` method also requires `npm` and outbound HTTPS access to the public npm registry. Networked toolchain setup is provider policy; bootstrap reports an actionable error instead of installing toolchains itself.

Node-backed `worker-turn` launches the self-contained worker loop and proxies model inference through the Gateway. Node-backed or SSH-backed `remote-exec` keeps the model loop on the Gateway and routes sandbox operations to the remote host. Node-backed Codex accepts process, filesystem, capability, and credential-free HTTP operations; authenticated HTTP is rejected before reaching the node. Both modes reconcile the session workspace and transcript through the durable placement lifecycle. A disconnected node-backed Codex attempt is terminal; reconnect permits only a fresh attempt, never process or stream resumption.

Each durable environment record retains its validated provider settings and resolved install method in a creation-time profile snapshot. Changing or removing a named profile affects new creates; existing records continue lifecycle reconciliation with that snapshot, provided the owning plugin remains available.

Profile changes require a Gateway restart. With the default `gateway.reload.mode: "hybrid"`, the config watcher performs the restart automatically; `"off"` mode requires a manual restart.

<Warning>
  The `static-ssh` provider is a source-tree QA Lab `remote-exec` harness and is excluded from packaged distributions. A worker running on its shared host can read unrelated host data, so do not use this provider as a production isolation boundary.
  Its operator must supply the expected `hostKey`; OpenClaw will not learn or accept a key from the first connection.
  Destroying its lease only releases OpenClaw's logical record; it does not stop or clean the host.
</Warning>

---
