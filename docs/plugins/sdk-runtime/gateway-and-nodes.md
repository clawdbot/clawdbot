---
summary: "In-process Gateway requests, paired node invocation, and Gateway service events"
read_when:
  - You are calling another Gateway method from a trusted plugin
  - You are invoking or streaming to a command on a paired node
  - You are registering a long-lived Gateway service
title: "Plugin runtime Gateway and nodes"
sidebarTitle: "Gateway and nodes"
---

Reach the Gateway and paired nodes from plugin code, and the events a long-lived Gateway service receives. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference.

## Gateway and node namespaces

<AccordionGroup>
  <Accordion title="api.runtime.gateway">
    Call another Gateway method in process while preserving the current plugin's trusted runtime
    identity. This is intended for bundled or trusted official plugins that compose plugin-owned
    Gateway capabilities without opening a loopback WebSocket connection.

    ```typescript
    if (await api.runtime.gateway.isAvailable()) {
      const result = await api.runtime.gateway.request<{ callId: string }>(
        "voicecall.start",
        { to: "+15550001234", mode: "conversation" },
        { timeoutMs: 60_000 },
      );
    }
    ```

    Requests use `operator.write` scope and do not grant admin scope. Calls from arbitrary external
    plugins are rejected. Failed methods throw a `GatewayClientRequestError`, preserving structured
    `details`, retry metadata, and the Gateway error code for recovery flows. Use `isAvailable()`
    before choosing this path from tools that can also run in standalone agent processes.

  </Accordion>
  <Accordion title="api.runtime.nodes">
    List connected nodes and invoke a node-host command from Gateway-loaded plugin code or from plugin CLI commands. Use this when a plugin owns local work on a paired device, for example a browser or audio bridge on another Mac.

    ```typescript
    const controller = new AbortController();
    const { nodes } = await api.runtime.nodes.list({ connected: true });

    const result = await api.runtime.nodes.invoke({
      nodeId: "mac-studio",
      command: "my-plugin.command",
      params: { action: "start" },
      timeoutMs: 30000,
      signal: controller.signal,
    });
    ```

    Pass the agent tool or request `AbortSignal` as `signal` when the caller can
    be canceled. Gateway-loaded calls forward cancellation to the paired node;
    node-host command handlers receive it as `context.signal` so they can stop
    in-flight requests and release local resources. Existing calls that omit the
    signal retain their previous behavior.

    Gateway-loaded plugins can open a connection-scoped binary channel to a
    registered node-host command with `nodes.openDuplex(...)`:

    ```typescript
    const controller = new AbortController();
    const channel = await api.runtime.nodes.openDuplex({
      nodeId: "paired-node",
      command: "my-plugin.image-bridge",
      params: { format: "png" },
      timeoutMs: 30000,
      maxMessageBytes: 4 * 1024 * 1024,
      signal: controller.signal,
    });

    const unsubscribe = channel.onMessage((message: Uint8Array) => {
      console.log("Received one complete binary message:", message.byteLength);
    });

    try {
      await channel.send(Uint8Array.of(1, 2, 3));
      const result = await channel.closed;
    } finally {
      unsubscribe();
      channel.close();
    }
    ```

    `openDuplex` accepts the same node, command, parameters, timeout,
    idempotency key, session key, caller signal, and requested scopes as
    `nodes.invoke`, plus optional `maxMessageBytes` and
    `maxOutstandingDeliveryBytes` limits. The per-message limit defaults to
    100 MiB and can be reduced, but never increased beyond 100 MiB.
    `maxOutstandingDeliveryBytes` bounds the combined size of complete messages
    whose asynchronous listener callbacks have not settled; it defaults to
    `maxMessageBytes`, cannot be smaller than that limit, and cannot exceed
    100 MiB. A protocol that can follow a maximum-sized response with a bounded
    asynchronous notification may request a larger outstanding-delivery budget
    without raising its per-message ceiling. OpenClaw splits each binary message
    into ordered 8 KiB payload fragments that fit the existing 16 KiB
    transport-frame limit; callers always send and receive complete
    `Uint8Array` messages. Concurrent sends preserve message boundaries.

    Register the channel's single message listener immediately after
    `openDuplex` resolves. Before a listener is registered, OpenClaw buffers at
    most eight complete messages and 1 MiB total; exceeding either limit closes
    the invocation. The unsubscribe callback removes that listener. Listeners
    may return `Promise<void>`; a thrown error or rejected promise, caller
    abort, `close()`, node disconnect, pairing change, plugin reload or
    retirement, or Gateway shutdown closes the channel and cancels outstanding
    node work. Successful node command completion and `channel.closed` wait
    for asynchronous message listeners already in progress. `close()` is
    idempotent, and retained channel methods reject after closure.
    `channel.closed` resolves with the successful command result or rejects
    with the node, authorization, transport, or cancellation error. Channels
    cannot reconnect or survive a node disconnection.

    The node plugin declares `duplex: true` and registers a message listener
    through the optional framed command I/O capability:

    ```typescript
    api.registerNodeHostCommand({
      command: "my-plugin.image-bridge",
      duplex: true,
      async handle(_paramsJSON, io) {
        if (!io?.frames) {
          throw new Error("Framed node command I/O is unavailable.");
        }

        const frames = io.frames;
        return await new Promise<string>((resolve, reject) => {
          frames.onMessage((message) => {
            void frames.send(message).then(() => resolve('{"ok":true}'), reject);
          });
          io.signal.addEventListener(
            "abort",
            () => reject(new Error("Node command was canceled.")),
            { once: true },
          );
        });
      },
    });
    ```

    Register `frames.onMessage(...)` before sending: the node announces framed
    readiness only after the listener exists, and `openDuplex` resolves only
    after both command dispatch and framed readiness. This prevents input from
    arriving before the plugin can consume it. The existing raw `emitChunk`
    and `onInput` helpers remain available to terminal-style commands.

    `openDuplex` is available only to a current, trusted in-process Gateway
    plugin runtime. Plugin CLI runtimes reject it with an actionable error;
    there is no remote polling or local fallback. Every invocation uses the
    same pairing, declared-command allowlist, plugin policy, approval,
    authorization, and connection-ownership checks as `nodes.invoke`.

    `nodes.list(...)` includes each connected node's advertised
    `nodePluginTools` descriptors when that node exposes plugin or MCP-backed
    tools to the agent. Those descriptors are live connection state: the Gateway
    drops them when the node disconnects, and a node can replace them with
    `node.pluginTools.update` after local plugin/MCP inventory changes.

    Inside the Gateway this runtime is in-process. In plugin CLI commands it calls the configured Gateway over RPC, so commands such as `openclaw googlemeet recover-tab` can inspect paired nodes from the terminal. Node commands still go through normal Gateway node pairing, command allowlists, plugin node-invoke policies, and node-local command handling.

    When execution identity auditing is enabled for an admitted run, those
    Gateway gates appear as enforced decision receipts. A successful node
    result is attribution-only. A policy that returns without calling its
    supplied `invokeNode` callback leaves the action unknown; returning a
    successful plugin result does not prove that the node action occurred.

    Plugins that expose node-hosted agent tools can set `agentTool.defaultPlatforms` for non-dangerous commands that should be allowlisted by default. Omit it when operators must opt in with `gateway.nodes.commands.allow`. Dangerous node-host commands should register a node-invoke policy with `api.registerNodeInvokePolicy(...)`; the policy runs in the Gateway after command allowlist checks and before the command is forwarded to the node, so direct `node.invoke` calls, node-hosted plugin tools, and higher-level plugin tools share the same enforcement path.

    `allow-always` remains one policy decision unless the node-invoke policy explicitly declares `standingApproval: { kind: "placement", scope: "<capability>" }`. That opt-in permits later launches only for a high-risk command on the same current managed placement, node pairing, environment owner, workspace, and semantic capability scope, for at most 30 days and never across Gateway restart. Use a stable, content-free scope for a capability whose approval deliberately covers later argument changes. Do not opt in when the approved target or other request arguments must remain exact.

    A node command may declare `prepare(context)` for asynchronous native startup.
    Node-host initialization awaits it before publishing the initial manifest or
    connecting to the Gateway; plugin registration itself stays synchronous.
    Shared preparation callbacks run once per node registry initialization, not
    per invocation or reconnect. Optional providers should retain a known
    unavailable state on expected preparation failure and let `isAvailable`
    withhold their commands; throwing aborts node startup. Use `watchAvailability`
    for later availability changes and `onDisconnect` for execution cleanup.

    <Warning>
    The optional `scopes` field requests Gateway operator scopes for the invocation. OpenClaw honors it only for bundled plugins and trusted official plugin installations; requests from other plugins do not elevate the call. When `openDuplex` runs inside an authenticated Gateway request, its effective scopes never exceed that authenticated caller's actual scopes, even if a trusted plugin requests stronger scopes. Without an authenticated incoming client, existing trusted-plugin scope behavior applies. Use requested scopes only when a trusted plugin must invoke a node command with a stricter Gateway scope, such as `operator.admin`.
    </Warning>

  </Accordion>
</AccordionGroup>

## Gateway service events

Gateway-hosted services also receive `ctx.getCron?.()` for the scheduler operations
already available to Gateway hooks: `list`, `add`, `update`, `remove`, and
`removeStaleJobFamily`. Non-Gateway service hosts omit this getter.

Use the service's `start()` and `stop()` methods to own recurring reconciliation.
They run for service or plugin replacement as well as Gateway startup and shutdown;
`gateway_start` and `gateway_stop` do not replay on plugin-only reload.
Each returned scheduler handle belongs to one service lifetime and one scheduler
instance. Calls, including queued writes, reject once service shutdown begins or
that scheduler is replaced. Call `ctx.getCron()` again to obtain the replacement
scheduler while the service remains active.

A service can declare `reload: { configPrefixes: ["myConfig.service"] }` alongside
its `id`, `start`, and `stop`. After a matching config change commits, the Gateway
stops that service and calls `start(ctx)` again with the new `ctx.config`. Only
loaded services declaring the matching prefix are replaced; overlapping owners
all refresh. Existing equal or narrower restart or no-op policies still take precedence.
Each start receives a new capability lease and health reporter. Stop must release
resources before resolving; failed replacement cleanup or startup triggers
Gateway recovery. A full plugin replacement subsumes these service restarts.

Trusted official diagnostics exporter services can also receive
`ctx.internalDiagnostics.getRuntimeIdentity?.()`. It returns the hosting
process's canonical `processInstanceId` and optional loaded `buildId`, with no
filesystem lookup or RPC. Capture it during service startup; a retained getter
throws after the service lease is revoked. Hosts that do not provide this
optional capability leave runtime identity unavailable. This diagnostic fact
does not grant authority or identify a service-reload epoch.

Long-lived services registered with `api.registerService(...)` receive a process-local
`ctx.gatewayEvents` facade when the process runs a Gateway broadcaster; in runtimes without one the
field is absent, so feature-detect it and keep a fallback (for example a coarse poll). Use
`onSessionsChanged(...)` to react after the Gateway broadcasts a `sessions.changed` notice:

```typescript
let unsubscribeSessionsChanged: (() => void) | undefined;

api.registerService({
  id: "session-index",
  start(ctx) {
    unsubscribeSessionsChanged = ctx.gatewayEvents?.onSessionsChanged((event) => {
      // event: { sessionKey, agentId?, label?, displayName?, reason?, phase? }
      refreshSession(event.sessionKey);
    });
  },
  stop() {
    unsubscribeSessionsChanged?.();
    unsubscribeSessionsChanged = undefined;
  },
});
```

The handler runs in the Gateway process and does not add a Gateway protocol subscription. Keep the
returned unsubscribe function and call it during service cleanup. The payload is a lightweight
change notice; use `api.runtime.agent.session.getSessionEntry(...)` when the plugin needs the full
current session entry.

OpenClaw calls a service's `stop()` at most once per startup attempt, including when a replacement
times out before startup fails. Failed-start rollback and shutdown share the same cleanup result;
a cleanup failure is recorded rather than retried within that attempt.

Service startup failures from a returned or awaited promise are recorded automatically. A service
that intentionally starts required work in the background must report later failure and recovery
through its generation-bound health reporter:

```typescript
api.registerService({
  id: "index-worker",
  start(ctx) {
    void startIndexWorker().then(
      () => ctx.serviceHealth?.clearFailure(),
      (error) => ctx.serviceHealth?.reportFailure(error),
    );
  },
  stop() {
    stopIndexWorker();
  },
});
```

The reporter is revoked when the service stops or its plugin registry generation is replaced, so a
late callback from an old generation cannot overwrite current health. Prefer returning the startup
promise when the service is not usable until that promise settles; use the reporter only for
deliberately nonblocking work that owns its own stop path.
