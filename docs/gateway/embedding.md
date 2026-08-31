---
summary: "Supervise the OpenClaw Gateway as a child process from Electron or another host app"
read_when:
  - Embedding OpenClaw in a desktop or server application
  - Supervising the Gateway as a child process
  - Handling Gateway readiness, restart, shutdown, or invalid config without scraping logs
title: "Embedding OpenClaw"
---

An embedding host should supervise the installed `openclaw` executable, use the
Gateway WebSocket protocol as its control plane, and treat the child process as a
replaceable runtime. This keeps process ownership, readiness, failure recovery,
and upgrades explicit without depending on OpenClaw's private state layout.

For client authentication and reconnect state, read
[Building a Gateway client](https://docs.openclaw.ai/gateway/clients).

## Start the child with an embedding preset

Use a real `node_modules` installation and spawn the package executable. A useful
baseline for a host that owns discovery, restart, and channel lifecycle is:

```ts
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Supply an absolute path to a real Node runtime managed by the host application.
declare const hostNodeExecutable: string;

const packageEntry = fileURLToPath(import.meta.resolve("openclaw"));
const openclawEntry = resolve(dirname(packageEntry), "..", "openclaw.mjs");
const gateway = spawn(hostNodeExecutable, [openclawEntry, "gateway", "--allow-unconfigured"], {
  env: {
    ...process.env,
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
```

Resolve OpenClaw through the installed package as shown; do not assume that a
project-local `openclaw` binary is on the host process's `PATH`. The example
inherits output so the child cannot block on full stdout or stderr pipes. If the
host captures those streams instead, attach consumers immediately after spawning.

| Setting                          | Embedding effect                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENCLAW_DISABLE_BONJOUR=1`     | Disables Gateway-owned LAN multicast advertising when the host owns discovery.                                                                                                             |
| `OPENCLAW_NO_RESPAWN=1`          | In an unmanaged embedding child, prevents OpenClaw from handing an update restart to a detached child. Routine restarts remain in process, so the host keeps ownership of the tracked PID. |
| `OPENCLAW_EXEC_SHELL_SNAPSHOT=0` | Disables login-shell snapshot capture for host exec commands.                                                                                                                              |
| `OPENCLAW_SKIP_CHANNELS=1`       | Skips channel startup and reload. Set it only when the embedding app wants a control-plane or WebChat-only Gateway.                                                                        |

`--allow-unconfigured` bypasses only the `gateway.mode=local` startup guard. It
does not write configuration or repair an invalid file. Omit it when the embedding
app provisions a normal local configuration through onboarding, the config CLI,
or Gateway RPC.

### Electron shell snapshot warning

Shell snapshot capture runs `process.execPath -e <script>` from a login shell. In
a normal Node process, `process.execPath` is the Node executable. Under Electron,
it is the Electron binary, which can interpret the invocation as an application
launch and show an "Unable to find Electron app" popup. Set
`OPENCLAW_EXEC_SHELL_SNAPSHOT=0` in the Gateway child's environment, not only in
the renderer process. For the same reason, `hostNodeExecutable` must point to a
real Node runtime rather than Electron's `process.execPath`.

## Handle invalid config by exit code

Gateway startup uses exit code `78` (`EX_CONFIG`) for configuration-class startup
failures, including an invalid config. Branch on the exit code instead of scraping
human-readable stderr:

1. Run `openclaw doctor --fix --yes --non-interactive` against the same config and
   state environment as the Gateway child.
2. Retry Gateway startup once after doctor exits successfully.
3. If the child exits `78` again, stop the repair loop and surface the config
   failure to the user.

Keep stderr for diagnostics, but do not make lifecycle decisions from its wording.

After a successful startup, an invalid live config edit is less destructive. The
config watcher logs that reload was skipped and continues serving the last accepted
in-memory config. Repair the file, then let the watcher accept the next valid
snapshot.

## Wait for protocol readiness

Use WebSocket signals instead of a log substring:

1. Open the Gateway WebSocket.
2. Wait for the `connect.challenge` event. It proves that the listener accepted the
   WebSocket and the challenge handshake can begin.
3. Send `connect` with the challenge-bound device signature.
4. Treat `hello-ok` as application readiness for authenticated RPC.

The challenge is deliberately earlier than full initialization. If startup
sidecars are still pending, `connect` returns a retryable `UNAVAILABLE` error with
`details.reason: "startup-sidecars"`, a bounded `retryAfterMs`, and then closes
with code `1013` and reason `gateway starting`. Use
`resolveGatewayStartupRetryAfterMs` from
`@openclaw/gateway-protocol/startup-unavailable` or the reference client's built-in
policy, then reconnect.

## Interpret restart and shutdown

Before an orderly close, the Gateway broadcasts a `shutdown` event with `reason`
and `restartExpectedMs`. A non-null `restartExpectedMs` means an in-process or
supervised restart is expected; `null` means a terminal shutdown.

The subsequent WebSocket close code is `1012` for both cases. The ordinary client
close reason is also `service restart` in both cases, so neither the close code nor
the reason distinguishes restart from shutdown. Preserve the preceding `shutdown`
payload when it arrives, and combine it with the host's own stop intent and the
child exit status. If the connection disappears without the event, use normal
bounded reconnect and child-supervision policy.

## Use RPC instead of state files

Keep the Gateway as the only owner of OpenClaw state. Common embedding operations
already have RPC methods:

| Task                          | RPC methods                                          |
| ----------------------------- | ---------------------------------------------------- |
| Session catalog and lifecycle | `sessions.list`, `sessions.patch`, `sessions.delete` |
| Transcript display            | `chat.history`                                       |
| Cost and usage reports        | `usage.cost`, `sessions.usage`                       |
| Model credential status       | `models.authStatus`                                  |
| Configuration                 | `config.get`, `config.patch`                         |

`config.get` redacts sensitive values and SecretRef identifiers before returning
the snapshot. Write methods also return redacted config. A client must treat the
redaction sentinel as opaque and use the documented config write contract; it
must never expect the Gateway to return plaintext secrets.

Do not read or mutate files, SQLite tables, transcript files, or cache directories
under `~/.openclaw` to implement app features. Those layouts are private runtime
implementation details and can move or change without protocol compatibility.

## Install; do not flatten

The root `openclaw` package is not a single-file vendoring target. Bundled runtime
files under `dist/extensions` retain bare self-imports such as
`openclaw/plugin-sdk/*`, while the npm package intentionally excludes
per-extension `node_modules` trees.

Install OpenClaw through npm, pnpm, or another normal Node package installation so
Node can resolve the package exports and root dependency tree. Spawn the installed
`openclaw` executable. Do not copy only `dist`, flatten the package into an app
bundle, or vendor selected extension files.

## Related

- [Building a Gateway client](https://docs.openclaw.ai/gateway/clients)
- [Gateway protocol](https://docs.openclaw.ai/gateway/protocol)
- [Gateway CLI](https://docs.openclaw.ai/cli/gateway)
- [Gateway integrations for external apps](https://docs.openclaw.ai/gateway/external-apps)
