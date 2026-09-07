---
summary: "Config snapshot, SQLite-backed plugin state, worktree retention, system utilities, events, and logging"
read_when:
  - You need durable keyed or blob storage scoped to your plugin
  - You need to retain managed worktrees for durable artifact references
  - You are buffering channel ingress across restarts
  - You need the config snapshot, system utilities, events, or a scoped logger
title: "Plugin runtime state and system"
sidebarTitle: "State and system"
---

The runtime config snapshot, durable plugin-scoped storage, worktree retention, system utilities, event subscriptions, and logging. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference; [Config and utilities](/plugins/sdk-runtime/config-and-utilities#config-loading-and-writes) covers the wider config read and write guidance.

## State, config, and system namespaces

<AccordionGroup>
  <Accordion title="api.runtime.config">
    Current runtime config snapshot and transactional config writes. Prefer
    config that was already passed into the active call path; use
    `current()` only when the handler needs the process snapshot directly.

    ```typescript
    const cfg = api.runtime.config.current();
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate(draft) {
        draft.plugins ??= {};
      },
    });
    ```

    `mutateConfigFile(...)` and `replaceConfigFile(...)` return a `followUp`
    value, for example `{ mode: "restart", requiresRestart: true, reason }`,
    which records the writer intent without taking restart control away from the
    gateway.

  </Accordion>
  <Accordion title="api.runtime.system">
    System-level utilities.

    ```typescript
    const accepted = api.runtime.system.enqueueSystemEvent(text, options);
    api.runtime.system.requestHeartbeat({
      source: "other",
      intent: "event",
      reason: "plugin-event",
    });
    api.runtime.system.requestHeartbeatNow({ reason: "plugin-event" }); // Deprecated compatibility alias.
    const heartbeatResult = await api.runtime.system.runHeartbeatOnce({
      reason: "plugin-triggered-check",
    });
    const output = await api.runtime.system.runCommandWithTimeout(cmd, args, opts);
    const hint = api.runtime.system.formatNativeDependencyHint(pkg);
    ```

    `runHeartbeatOnce(...)` runs a single heartbeat cycle immediately, bypassing the normal coalesce timer. Delivery defaults to the configured operator DM (`commands.ownerAllowFrom`, then channel `allowFrom`); pass `{ heartbeat: { target: "none" } }` for an internal-only run.

    `runCommandWithTimeout(...)` returns captured `stdout` and `stderr`, optional
    truncation counts, `code`, `signal`, `killed`, `termination`, and
    `noOutputTimedOut`. Timeout and no-output-timeout results report `code: 124`
    when the child process does not provide a non-zero exit code. Non-timeout
    signal exits can still return `code: null`, so use `termination` and
    `noOutputTimedOut` to distinguish timeout reasons.

  </Accordion>
  <Accordion title="api.runtime.events">
    Event subscriptions.

    ```typescript
    api.runtime.events.onAgentEvent((event) => {
      /* ... */
    });
    api.runtime.events.onSessionTranscriptUpdate((update) => {
      /* ... */
    });
    ```

  </Accordion>
  <Accordion title="api.runtime.logging">
    Logging.

    ```typescript
    const verbose = api.runtime.logging.shouldLogVerbose();
    const childLogger = api.runtime.logging.getChildLogger({ plugin: "my-plugin" }, { level: "debug" });
    ```

  </Accordion>
  <Accordion title="api.runtime.state">
    State directory resolution and SQLite-backed keyed storage.

    ```typescript
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    const store = api.runtime.state.openKeyedStore<MyRecord>({
      namespace: "my-feature",
      maxEntries: 200,
      defaultTtlMs: 15 * 60_000,
    });

    await store.register("key-1", { value: "hello" });
    const claimed = await store.registerIfAbsent("dedupe-key", { value: "first" });
    const value = await store.lookup("key-1");
    await store.deleteIf?.("key-1", (current) => current.value === "hello");
    await store.consume("key-1");
    await store.clear();

    const blobs = api.runtime.state.openBlobStore<MyBlobMetadata>({
      namespace: "rendered-artifacts",
      maxEntries: 100,
      maxBytesPerEntry: 4 * 1024 * 1024,
      maxBytesPerNamespace: 64 * 1024 * 1024,
      defaultTtlMs: 15 * 60_000,
    });
    await blobs.register(
      "artifact-1",
      new TextEncoder().encode("binary or text payload"),
      { contentType: "text/plain" },
    );
    const blob = await blobs.lookup("artifact-1");
    ```

    Keyed stores survive restarts and are isolated by the runtime-bound plugin id. Use `registerIfAbsent(...)` for atomic dedupe claims: it returns `true` when the key was missing or expired and registered, or `false` when a live value already exists without overwriting its value, creation time, or TTL. Use `deleteIf(...)` when cleanup must remove only the value previously observed; its synchronous predicate and deletion run in one SQLite transaction. Limits: `maxEntries` per namespace, 50,000 live rows per plugin, JSON values up to 1 MiB of UTF-8 encoded JSON, and optional TTL expiry. By default, a write at either row limit sheds the oldest live rows from the namespace being written; sibling namespaces are not evicted for that write, and the write still fails if the namespace cannot free enough rows. Set `overflowPolicy: "reject-new"` for durable ownership records that must never be evicted: new keys fail at either limit, while existing keys remain updateable.

    `lookupMany(keys)` is an optional keyed-store capability for at most 10,000 exact keys per call. Results have the same length and order as the input, including duplicates. Each position is a `Result<T | undefined, PluginStateStoreError>`: `{ ok: true, value }` on success, including `value: undefined` for missing or expired keys, or `{ ok: false, error }` for corrupt stored JSON. An empty request returns `[]`. Keys use the same trimming and 512-byte UTF-8 limit as `lookup`; invalid keys or an oversized request fail with `PLUGIN_STATE_INVALID_INPUT` and operation `lookup` before reading. Database acquisition and query errors fail the whole call. Corrupt-JSON errors retain the `lookup` error code and operation in their per-key result. Inspect each result only when the reader reaches that position, and throw `result.error` if it is not `ok`; this lets a reader stop at an earlier missing or invalid chunk without raising a later corruption error. Each call uses one expiry cutoff and one SQLite selection in the same plugin and namespace, without creating a missing database. Separate calls, including metadata reads, do not share a snapshot; chunked formats must retain their generation, digest, and reader-lifetime checks.

    Current host factories provide `lookupMany`, but the public store types keep it optional for existing third-party adapters and declared older host versions. A plugin supporting those hosts must check the method and use its existing sequential `lookup` path when absent; never retry a failed bulk read through that path. Matrix, Microsoft Teams, and Voice Call retain this compatibility until their declared minimum host supplies the capability. Do not import a new helper export from an older host just to detect this method.

    `openSyncKeyedStore<T>(...)` returns the same store shape with synchronous methods (`register`, `registerIfAbsent`, `deleteIf`, `lookup`, `lookupMany`, `consume`, `clear` all return values directly instead of promises) for callers that cannot await.

    `openBlobStore<TMetadata>(...)` stores bounded binary payloads in shared SQLite without base64 or file sidecars. It requires per-entry, per-namespace byte, and row limits; copies byte arrays at the API boundary; and lists metadata without loading every BLOB. `register(...)` is an explicit upsert, including for expired keys. `registerIfAbsent(...)` provides collision-safe creation: an expired key remains occupied until its owner claims it with `deleteExpiredKey(key)` or `deleteExpired()`, preserving metadata needed to remove related named artifacts after the SQLite commit. Any row with a TTL is transient and excluded from backup/restore even before it expires; omit TTL for durable, restorable state. Host fuses cap each BLOB at 100 MiB, each plugin at 512 MiB of physically stored BLOBs, and each plugin at 50,000 physically stored rows, including expired rows awaiting owner cleanup. Use `registerIfAbsent(...)` with `overflowPolicy: "reject-new"` when external materializations must not be silently orphaned by replacement or eviction.

    `openChannelIngressQueue<TPayload>(...)` opens a persisted ingress queue scoped to the calling plugin, for buffering inbound events that need at-least-once processing across restarts. When stale-claim recovery uses `shouldRecover`, also provide `shouldRecoverCorrupt` if corrupt claimed payloads should be quarantined: its payload-independent claim identity lets the plugin preserve live owner and lane policy before the queue tombstones the row.

    Plugin-state leases were removed. Use short SQLite transactions for atomic database work and plugin-scoped keyed stores (`openKeyedStore` or `openSyncKeyedStore`) for bounded durable state.

    `openChannelIngressDrain(...)` opens the core channel-agnostic worker over that queue (or creates a queue when none is supplied). The drain owns stale-claim recovery, per-lane claim serialization, complete-at-adoption or complete-on-dispatch-return, retry/dead-letter disposition, optional pre-adoption supersede, and claim→adoption stall timeout. Wire claim ownership into reply generation with `turnAdoptionLifecycle` (via `bindIngressLifecycleToReplyOptions` from `plugin-sdk/channel-outbound`). Channel plugins keep accept-side enqueue, lane derivation, non-retryable classification, and any supersede authorization policy.

    <Warning>
    `openBlobStore`, `openKeyedStore`, `openSyncKeyedStore`, `openChannelIngressQueue`, and `openChannelIngressDrain` are available only to bundled plugins and trusted official plugin installations in this release. Refusals include the recorded reason, registry database path, origin, and install source/spec; `plugins inspect` reports the same trust facts. A load path selecting the recorded official installation preserves trust; an untracked local copy does not. See [Trusted plugin state refused](/tools/plugin#trusted-plugin-state-refused) for doctor migrations and cause-specific remedies. An untrusted channel's ingress monitor fails channel start instead of running without a durable queue.
    </Warning>

  </Accordion>
  <Accordion title="api.runtime.worktrees">
    Manage Workboard-owned Git worktrees without importing core worktree internals.

    Resolve the exact card-owned worktree before preparing a durable artifact reference:

    ```typescript
    const worktreeId = await api.runtime.worktrees.resolveRetentionTarget({
      path: workspace.path,
      ownerKind: "workboard",
      ownerId: card.id,
    });
    if (!worktreeId) {
      throw new Error("The card's managed worktree is unavailable");
    }
    ```

    This read-only lookup returns the immutable registry ID, or `undefined` if the path
    is not a live worktree owned by that card. Persist that ID and a fresh `claimId` in
    the card owner's prepared generation before acquisition. Claim IDs must be nonempty.
    The following `generation` values must come from that durable record; replaying the
    same preparation uses the same ID, while retrying a cancelled mutation needs a new one:

    ```typescript
    const claim = {
      worktreeId: generation.worktreeId,
      ownerKind: "workboard" as const,
      ownerId: card.id,
      claimId: generation.claimId,
    };
    const retained = await api.runtime.worktrees.setRetentionClaim({
      ...claim,
      active: true,
    });
    if (!retained) {
      throw new Error("Retention was cancelled or the worktree is unavailable");
    }
    ```

    Acquire before publishing the reference. Commit the card, its active generation, and
    any previous generation's cleanup obligation in one transaction in the card owner's
    database. Only then release an obsolete generation with
    `setRetentionClaim({ ...claim, active: false })`. Do not keep cleanup only in memory.

    Claims are keyed by worktree ID and claim ID. Release is idempotent and terminal,
    even if it arrives before acquisition: that generation can never become active again.
    A later reference uses a new generation; an ordinary card edit can reuse its still-active
    generation. Acquisition returns `false` for a released claim, removed worktree, or
    owner mismatch, and throws if removal is in progress. Release of a permanently deleted
    registry ID succeeds without recreating a row; an owner mismatch returns `false`.

    Active claims survive Gateway restarts and protect automatic run-end, idle, count,
    and size cleanup. Explicit operator removal still applies. Released records remain
    through checkout removal and restore, and are pruned with their registry identity.
    See [Workboard artifact retention](/reference/database-schemas#workboard-artifact-retention)
    for recovery and downgrade boundaries.

  </Accordion>
</AccordionGroup>
