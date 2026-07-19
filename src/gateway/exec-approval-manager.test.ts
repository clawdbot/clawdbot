/**
 * Tests exec approval manager state transitions and timeout behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalDecision, ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  ExecApprovalManager,
  InvalidApprovalIdError,
  type OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.js";
import { getOperatorApprovalDetailed, resolveOperatorApproval } from "./operator-approval-store.js";

type TimeoutCallback = Parameters<typeof setTimeout>[0];
type ExecApprovalManagerOptions<TPayload> = ConstructorParameters<
  typeof ExecApprovalManager<TPayload>
>[0] extends infer T
  ? NonNullable<T>
  : never;
type GetOperatorApprovalParams = Parameters<typeof getOperatorApprovalDetailed>[0];

function getOperatorApproval(params: GetOperatorApprovalParams) {
  const result = getOperatorApprovalDetailed(params);
  return result.outcome === "found" ? result.record : null;
}
type MockTimerHandle = ReturnType<typeof setTimeout> & {
  unref: ReturnType<typeof vi.fn>;
};

describe("ExecApprovalManager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabase();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createPersistentManager(
    options: {
      runtimeEpoch?: string;
      onError?: ExecApprovalManagerOptions<ExecApprovalRequestPayload>["onError"];
      onLifecycle?: ExecApprovalManagerOptions<ExecApprovalRequestPayload>["onLifecycle"];
    } = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-manager-"));
    tempDirs.push(dir);
    const databaseOptions = { path: path.join(dir, "state.sqlite") };
    return {
      dir,
      databaseOptions,
      manager: new ExecApprovalManager<ExecApprovalRequestPayload>({
        approvalKind: "exec",
        persistence: { runtimeEpoch: options.runtimeEpoch ?? "runtime-a", databaseOptions },
        resolveAllowedDecisions: () => ["allow-once", "deny"],
        resolveAudienceSessionKeys: (sessionKey) => [sessionKey, "agent:main:parent"],
        onError: options.onError,
        onLifecycle: options.onLifecycle,
      }),
    };
  }

  function installTimerMocks() {
    const timers: Array<{
      callback: TimeoutCallback;
      delay: number | undefined;
      handle: MockTimerHandle;
    }> = [];

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimeoutCallback,
      delay?: number,
    ) => {
      const handle = { unref: vi.fn() } as unknown as MockTimerHandle;
      timers.push({ callback, delay, handle });
      return handle;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => undefined) as typeof clearTimeout,
    );

    return timers;
  }

  function runTimer(timer: { callback: TimeoutCallback } | undefined): void {
    if (!timer || typeof timer.callback !== "function") {
      throw new Error("expected timer callback");
    }
    timer.callback();
  }

  it("does not keep resolved approval cleanup timers ref'd", async () => {
    const timers = installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-resolve");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.resolve("approval-resolve", "allow-once")).toBe(true);
    await expect(decisionPromise).resolves.toBe("allow-once");
    expect(manager.getSnapshot("approval-resolve")?.resolutionSource).toBe("operator");

    const cleanupTimer = timers.find((timer) => timer.delay === 15_000);
    expect(cleanupTimer?.handle.unref).toHaveBeenCalledTimes(1);
  });

  it("records trusted auto-review as a closed one-shot resolution source", async () => {
    installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-auto-review");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.resolveAutoReview("approval-auto-review", "agent-runtime")).toBe(true);
    await expect(decisionPromise).resolves.toBe("allow-once");
    expect(manager.getSnapshot("approval-auto-review")).toMatchObject({
      decision: "allow-once",
      resolutionSource: "auto-review",
      resolvedBy: "agent-runtime",
    });
  });

  it("does not keep expired approval cleanup timers ref'd", async () => {
    const timers = installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-expire");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.expire("approval-expire")).toBe(true);
    await expect(decisionPromise).resolves.toBeNull();

    const cleanupTimer = timers.find((timer) => timer.delay === 15_000);
    expect(cleanupTimer?.handle.unref).toHaveBeenCalledTimes(1);
  });

  it("consumes an expired approval as ask-fallback only once", async () => {
    installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-fallback");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.expire("approval-fallback")).toBe(true);
    await expect(decisionPromise).resolves.toBeNull();

    expect(manager.consumeAskFallback("approval-fallback")).toBe(true);
    expect(manager.consumeAskFallback("approval-fallback")).toBe(false);
    expect(manager.getSnapshot("approval-fallback")?.askFallbackConsumed).toBe(true);
  });

  it("rejects ask-fallback replay of an allow-once approval", async () => {
    installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-allow-once");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.resolve("approval-allow-once", "allow-once")).toBe(true);
    await expect(decisionPromise).resolves.toBe("allow-once");

    expect(manager.consumeAskFallback("approval-allow-once")).toBe(false);
    expect(manager.consumeAllowOnce("approval-allow-once")).toBe(true);
    expect(manager.consumeAskFallback("approval-allow-once")).toBe(false);
  });

  it("retains a resolved live binding across a slow handoff and cleans up after release", () => {
    const timers = installTimerMocks();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-handoff");
    void manager.register(record, 60_000);
    const releaseFirst = manager.retainForHandoff(record.id);
    const releaseSecond = manager.retainForHandoff(record.id);
    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();
    manager.resolveDetailed(record.id, "allow-once", { kind: "device", id: "device-1" });
    now.mockReturnValue(20_000);

    expect(manager.getLiveSnapshot(record.id)).toMatchObject({ decision: "allow-once" });
    expect(manager.consumeAllowOnce(record.id)).toBe(true);
    expect(timers.filter((timer) => timer.delay === 15_000)).toHaveLength(0);

    releaseFirst?.();
    expect(timers.filter((timer) => timer.delay === 15_000)).toHaveLength(0);
    releaseSecond?.();
    const cleanupTimers = timers.filter((timer) => timer.delay === 15_000);
    expect(cleanupTimers).toHaveLength(1);
    releaseSecond?.();
    expect(timers.filter((timer) => timer.delay === 15_000)).toHaveLength(1);

    runTimer(cleanupTimers[0]);
    expect(manager.getLiveSnapshot(record.id)).toBeNull();
  });

  it("ignores a stale cleanup callback after handoff restarts the grace period", () => {
    const timers = installTimerMocks();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-handoff-race");
    void manager.register(record, 60_000);
    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    const staleCleanup = timers.find((timer) => timer.delay === 15_000);

    const release = manager.retainForHandoff(record.id);
    now.mockReturnValue(2_000);
    release?.();
    const cleanupTimers = timers.filter((timer) => timer.delay === 15_000);
    expect(cleanupTimers).toHaveLength(2);

    runTimer(staleCleanup);
    expect(manager.getLiveSnapshot(record.id)).toMatchObject({ decision: "allow-once" });
    runTimer(cleanupTimers[1]);
    expect(manager.getLiveSnapshot(record.id)).toBeNull();
  });

  it("clamps oversized approval timers instead of letting Node fire them immediately", () => {
    const timers = installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const manager = new ExecApprovalManager();
    const record = manager.create(
      { command: "echo ok" },
      MAX_TIMER_TIMEOUT_MS + 1,
      "approval-long",
    );

    void manager.register(record, MAX_TIMER_TIMEOUT_MS + 1);

    expect(record.expiresAtMs).toBe(1_000 + MAX_TIMER_TIMEOUT_MS);
    expect(timers[0]?.delay).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("schedules registration from the record's remaining lifetime", () => {
    const timers = installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(1_250);
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-delayed");

    void manager.register(record, 60_000);

    expect(record.expiresAtMs).toBe(61_000);
    expect(timers[0]?.delay).toBe(59_750);
  });

  it("reschedules a deadline timer when the wall clock rolls backward", async () => {
    const timers = installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-clock-rollback");
    const decisionPromise = manager.register(record, 60_000);
    vi.mocked(Date.now).mockReturnValue(500);

    runTimer(timers[0]);

    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "pending",
    });
    expect(timers[1]?.delay).toBe(60_500);

    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);
    runTimer(timers[1]);
    await expect(decisionPromise).resolves.toBeNull();
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "expired",
    });
  });

  it("rejects approval records when expiry would exceed the Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const manager = new ExecApprovalManager();

    expect(() => manager.create({ command: "echo ok" }, 1, "approval-overflow")).toThrow(
      "approval expiry is unavailable",
    );
  });

  it("persists registration before releasing the waiter from the durable verdict", async () => {
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create(
      { command: "echo ok", sessionKey: "agent:main:child" },
      60_000,
      "approval-durable",
    );
    const decisionPromise = manager.register(record, 60_000);

    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      id: record.id,
      kind: "exec",
      status: "pending",
      runtimeEpoch: "runtime-a",
      source: { sessionKey: "agent:main:child" },
      audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
    });

    expect(
      manager.resolveDetailed(
        record.id,
        "allow-once",
        {
          kind: "channel",
          id: "telegram:operator",
        },
        "Telegram Operator",
      ),
    ).toMatchObject({ outcome: "resolved" });
    await expect(decisionPromise).resolves.toBe("allow-once");
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      resolver: { kind: "channel", id: "telegram:operator" },
    });
    expect(manager.getLiveSnapshot(record.id)).toMatchObject({
      resolvedBy: "Telegram Operator",
    });
  });

  it("emits pending only after durable insert and live waiter registration", async () => {
    let durableAtCallback: ReturnType<typeof getOperatorApproval> = null;
    let waiterAtCallback: Promise<ExecApprovalDecision | null> | null = null;
    const lifecycleEvents: OperatorApprovalLifecycleEvent[] = [];
    // The lifecycle callback fires only during register(), after
    // createPersistentManager has returned, so `created` is initialized.
    const created = createPersistentManager({
      onLifecycle: (event) => {
        lifecycleEvents.push(event);
        if (event.phase === "pending") {
          durableAtCallback = getOperatorApproval({
            id: event.record.id,
            databaseOptions: created.databaseOptions,
          });
          waiterAtCallback = created.manager.awaitDecision(event.record.id);
        }
      },
    });
    const manager = created.manager;
    const record = manager.create(
      { command: "echo ordered", sessionKey: "agent:main:child" },
      60_000,
      "approval-lifecycle-ordered",
    );

    const decisionPromise = manager.register(record, 60_000);

    expect(lifecycleEvents).toMatchObject([
      {
        phase: "pending",
        record: {
          id: record.id,
          status: "pending",
          audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
        },
      },
    ]);
    expect(durableAtCallback).toEqual(lifecycleEvents[0]?.record);
    expect(waiterAtCallback).toBe(decisionPromise);

    manager.resolveDetailed(record.id, "deny", { kind: "system", id: null });
    await expect(decisionPromise).resolves.toBe("deny");
  });

  it("passes the source agent when deriving a global-session stream audience", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-manager-"));
    tempDirs.push(dir);
    const databaseOptions = { path: path.join(dir, "state.sqlite") };
    const resolveAudienceSessionKeys = vi.fn((sessionKey: string, agentId?: string | null) => [
      sessionKey === "global" && agentId ? `agent:${agentId}:global` : sessionKey,
    ]);
    const manager = new ExecApprovalManager<ExecApprovalRequestPayload>({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "runtime-a", databaseOptions },
      resolveAllowedDecisions: () => ["allow-once", "deny"],
      resolveAudienceSessionKeys,
    });
    const record = manager.create(
      { command: "echo global", sessionKey: "global", agentId: "work" },
      60_000,
      "approval-global-audience",
    );
    const decisionPromise = manager.register(record, 60_000);

    expect(resolveAudienceSessionKeys).toHaveBeenCalledWith("global", "work");
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      source: { sessionKey: "global", agentId: "work" },
      audienceSessionKeys: ["agent:work:global"],
    });

    manager.resolveDetailed(record.id, "deny", { kind: "system", id: null });
    await expect(decisionPromise).resolves.toBe("deny");
  });

  it("emits one terminal event for the winning resolution and none for later answers", async () => {
    const lifecycleEvents: OperatorApprovalLifecycleEvent[] = [];
    const { manager } = createPersistentManager({
      onLifecycle: (event) => lifecycleEvents.push(event),
    });
    const record = manager.create({ command: "echo race" }, 60_000, "approval-lifecycle-race");
    const decisionPromise = manager.register(record, 60_000);

    expect(
      manager.resolveDetailed(record.id, "allow-once", {
        kind: "device",
        id: "control-ui",
      }),
    ).toMatchObject({ outcome: "resolved" });
    expect(
      manager.resolveDetailed(record.id, "deny", {
        kind: "channel",
        id: "telegram",
      }),
    ).toMatchObject({ outcome: "already-resolved", retry: "conflict" });
    await expect(decisionPromise).resolves.toBe("allow-once");

    expect(lifecycleEvents.map((event) => event.phase)).toEqual(["pending", "terminal"]);
    expect(lifecycleEvents[1]?.record).toMatchObject({
      id: record.id,
      status: "allowed",
      decision: "allow-once",
      resolver: { kind: "device", id: "control-ui" },
    });
  });

  it("emits a terminal event when the durable timeout wins", async () => {
    const timers = installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const lifecycleEvents: OperatorApprovalLifecycleEvent[] = [];
    const { manager } = createPersistentManager({
      onLifecycle: (event) => lifecycleEvents.push(event),
    });
    const record = manager.create(
      { command: "echo timeout" },
      60_000,
      "approval-lifecycle-timeout",
    );
    const decisionPromise = manager.register(record, 60_000);
    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);

    runTimer(timers[0]);

    await expect(decisionPromise).resolves.toBeNull();
    expect(lifecycleEvents.map((event) => event.phase)).toEqual(["pending", "terminal"]);
    expect(lifecycleEvents[1]?.record).toMatchObject({
      id: record.id,
      status: "expired",
      decision: "deny",
      terminalReason: "timeout",
    });
  });

  it("emits a terminal event for an explicit force-deny transition", async () => {
    const lifecycleEvents: OperatorApprovalLifecycleEvent[] = [];
    const { manager } = createPersistentManager({
      onLifecycle: (event) => lifecycleEvents.push(event),
    });
    const record = manager.create(
      { command: "echo malformed" },
      60_000,
      "approval-lifecycle-force-deny",
    );
    const decisionPromise = manager.register(record, 60_000);

    expect(
      manager.forceDenyDetailed(record.id, "malformed-verdict", {
        kind: "system",
        id: "invalid-verdict",
      }),
    ).toMatchObject({ outcome: "denied" });
    await expect(decisionPromise).resolves.toBe("deny");

    expect(lifecycleEvents.map((event) => event.phase)).toEqual(["pending", "terminal"]);
    expect(lifecycleEvents[1]?.record).toMatchObject({
      id: record.id,
      status: "denied",
      decision: "deny",
      terminalReason: "malformed-verdict",
    });
  });

  it("isolates lifecycle callback failures from registration and resolution", async () => {
    const onLifecycle = vi.fn(() => {
      throw new Error("stream unavailable");
    });
    const { manager, databaseOptions } = createPersistentManager({ onLifecycle });
    const record = manager.create(
      { command: "echo isolated" },
      60_000,
      "approval-lifecycle-isolation",
    );

    let decisionPromise!: Promise<ExecApprovalDecision | null>;
    expect(() => {
      decisionPromise = manager.register(record, 60_000);
    }).not.toThrow();
    expect(() =>
      manager.resolveDetailed(record.id, "deny", {
        kind: "device",
        id: "control-ui",
      }),
    ).not.toThrow();
    await expect(decisionPromise).resolves.toBe("deny");

    expect(onLifecycle).toHaveBeenCalledTimes(2);
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "denied",
      decision: "deny",
    });
  });

  it("does not re-emit pending for an idempotent persisted registration", () => {
    installTimerMocks();
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create(
      { command: "echo replay", sessionKey: "agent:main:child" },
      60_000,
      "approval-lifecycle-existing",
    );
    const originalPromise = manager.register(record, 60_000);
    const onLifecycle = vi.fn();
    const replayManager = new ExecApprovalManager<ExecApprovalRequestPayload>({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "runtime-a", databaseOptions },
      resolveAllowedDecisions: () => ["allow-once", "deny"],
      resolveAudienceSessionKeys: (sessionKey) => [sessionKey, "agent:main:parent"],
      onLifecycle,
    });

    const replayPromise = replayManager.register(
      { ...record, request: { ...record.request } },
      60_000,
    );

    expect(replayManager.awaitDecision(record.id)).toBe(replayPromise);
    expect(onLifecycle).not.toHaveBeenCalled();
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      id: record.id,
      status: "pending",
    });

    manager.resolveDetailed(record.id, "deny", { kind: "system", id: null });
    replayManager.resolveDetailed(record.id, "deny", { kind: "system", id: null });
    return Promise.all([
      expect(originalPromise).resolves.toBe("deny"),
      expect(replayPromise).resolves.toBe("deny"),
    ]);
  });

  it("persists only the reviewer-safe presentation while retaining the local request", async () => {
    const { manager, databaseOptions } = createPersistentManager();
    const request: ExecApprovalRequestPayload = {
      command: "echo safe",
      commandArgv: ["/bin/echo", "hidden-argv-value"],
      cwd: "/hidden/cwd/value",
      systemRunBinding: {
        argv: ["/bin/echo", "hidden-binding-argv"],
        cwd: "/hidden/binding/cwd",
        agentId: "main",
        sessionKey: "agent:main:secret",
        envHash: "hidden-env-hash",
      },
    };
    const record = manager.create(request, 60_000, "approval-safe-presentation");
    const decisionPromise = manager.register(record, 60_000);

    const durable = getOperatorApproval({ id: record.id, databaseOptions });
    expect(durable?.presentation).toMatchObject({ kind: "exec", commandText: "echo safe" });
    const durableJson = JSON.stringify(durable);
    expect(durableJson).not.toContain("hidden-argv-value");
    expect(durableJson).not.toContain("/hidden/cwd/value");
    expect(durableJson).not.toContain("hidden-env-hash");

    const database = openOpenClawStateDatabase(databaseOptions);
    const row = database.db
      .prepare("SELECT presentation_json FROM operator_approvals WHERE approval_id = ?")
      .get(record.id) as { presentation_json?: unknown } | undefined;
    expect(String(row?.presentation_json)).not.toContain("hidden-");
    expect(manager.getLiveSnapshot(record.id)?.request).toBe(request);
    expect(manager.listPendingRecords()[0]?.request).toBe(request);
    expect(manager.awaitDecision(record.id)).toBe(decisionPromise);

    manager.resolveDetailed(record.id, "deny", { kind: "device", id: "control-ui" });
    await expect(decisionPromise).resolves.toBe("deny");
  });

  it.each([
    ["UUID", "12345678-1234-1234-1234-123456789abc"],
    ["plugin UUID", "plugin:12345678-1234-1234-1234-123456789abc"],
    ["system-agent UUID", "system-agent:12345678-1234-1234-1234-123456789abc"],
    ["node id", "node:mac-studio_1.local"],
  ])("preserves a safe explicit %s byte-for-byte", (_label, id) => {
    const manager = new ExecApprovalManager();

    expect(manager.create({ command: "echo exact" }, 60_000, id).id).toBe(id);
  });

  it.each([
    ["empty value", ""],
    ["URL dot segment", "."],
    ["URL parent segment", ".."],
    ["ANSI escape", "approval-\u001b[31mred"],
    ["Unicode control", "approval-\u202Ehidden"],
    ["trailing line feed", "approval-safe\n"],
    ["trailing carriage return", "approval-safe\r"],
    ["trailing line separator", "approval-safe\u2028"],
    ["trailing paragraph separator", "approval-safe\u2029"],
    ["overlong value", "a".repeat(129)],
  ])("rejects an explicit approval id containing an %s", (_label, id) => {
    const manager = new ExecApprovalManager();

    expect(() => manager.create({ command: "echo unsafe" }, 60_000, id)).toThrow(
      InvalidApprovalIdError,
    );
  });

  it("rejects unrenderable persistent plugin requests before creating a row or waiter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-manager-"));
    tempDirs.push(dir);
    const databaseOptions = { path: path.join(dir, "state.sqlite") };
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence: { runtimeEpoch: "runtime-plugin", databaseOptions },
    });
    const requests: PluginApprovalRequestPayload[] = [
      { title: "", description: "Needs approval" },
      { title: "Sensitive action", description: " \t " },
    ];

    for (const [index, request] of requests.entries()) {
      const id = `plugin:invalid-presentation-${index}`;
      const record = manager.create(request, 60_000, id);

      expect(() => manager.register(record, 60_000)).toThrow(
        "approval cannot be persisted without a valid reviewer presentation",
      );
      expect(manager.awaitDecision(id)).toBeNull();
      expect(getOperatorApproval({ id, databaseOptions })).toBeNull();
    }
  });

  it("keeps the first durable answer when a later surface conflicts", async () => {
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-race");
    const decisionPromise = manager.register(record, 60_000);

    expect(
      manager.resolveDetailed(record.id, "allow-once", { kind: "device", id: "control-ui" }),
    ).toMatchObject({ outcome: "resolved" });
    expect(
      manager.resolveDetailed(record.id, "deny", { kind: "channel", id: "telegram" }),
    ).toMatchObject({ outcome: "already-resolved", retry: "conflict" });
    await expect(decisionPromise).resolves.toBe("allow-once");
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      decision: "allow-once",
      resolver: { id: "control-ui" },
    });
  });

  it("persists timeout denial while preserving the null waiter result", async () => {
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-timeout");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.expire(record.id)).toBe(true);
    await expect(decisionPromise).resolves.toBeNull();
    expect(manager.getSnapshot(record.id)).toMatchObject({
      status: "expired",
      terminalReason: "timeout",
      resolvedBy: null,
    });
    expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "expired",
      decision: "deny",
      terminalReason: "timeout",
    });
  });

  it("persists no-route denial while preserving the null waiter result", async () => {
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-no-route");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.expire(record.id, "no-approval-route")).toBe(true);
    await expect(decisionPromise).resolves.toBeNull();
    expect(manager.getSnapshot(record.id)).toMatchObject({
      status: "denied",
      terminalReason: "no-route",
      resolvedBy: "no-approval-route",
    });
    expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "denied",
      decision: "deny",
      terminalReason: "no-route",
    });
  });

  it("reconciles local reads with the durable expiry boundary", async () => {
    installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-read-expiry");
    const decisionPromise = manager.register(record, 60_000);
    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);

    expect(manager.getSnapshot(record.id)).toMatchObject({ status: "expired" });
    expect(manager.listPendingRecords()).toEqual([]);
    await expect(decisionPromise).resolves.toBeNull();
  });

  it("reconciles awaitDecision with the durable expiry boundary", async () => {
    installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-await-expiry");
    void manager.register(record, 60_000);
    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);

    const decisionPromise = manager.awaitDecision(record.id);

    expect(decisionPromise).not.toBeNull();
    await expect(decisionPromise).resolves.toBeNull();
    expect(manager.getSnapshot(record.id)).toMatchObject({ status: "expired" });
  });

  it("reconciles force-deny with an approval that already reached expiry", async () => {
    installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-force-expiry");
    const decisionPromise = manager.register(record, 60_000);
    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);

    expect(
      manager.forceDenyDetailed(record.id, "malformed-verdict", {
        kind: "device",
        id: "control-ui",
      }),
    ).toMatchObject({ outcome: "expired", record: { status: "expired" } });
    await expect(decisionPromise).resolves.toBeNull();
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "expired",
      decision: "deny",
      terminalReason: "timeout",
    });
  });

  it("reports persistence failures from the timeout callback without throwing", async () => {
    const timers = installTimerMocks();
    const onError = vi.fn();
    const { manager, databaseOptions, dir } = createPersistentManager({ onError });
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-timer-error");
    const decisionPromise = manager.register(record, 60_000);
    const blocker = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocker, "blocked");
    databaseOptions.path = path.join(blocker, "state.sqlite");

    expect(() => runTimer(timers[0])).not.toThrow();
    await expect(decisionPromise).resolves.toBe("deny");
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        approvalId: record.id,
        approvalKind: "exec",
        operation: "expire",
      }),
    );
  });

  it("keeps a storage-failure deny authoritative after persistence recovers", async () => {
    installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager, databaseOptions, dir } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-storage-recover");
    const decisionPromise = manager.register(record, 60_000);
    const validDatabasePath = databaseOptions.path;
    const blocker = path.join(dir, "storage-blocker");
    fs.writeFileSync(blocker, "blocked");
    databaseOptions.path = path.join(blocker, "state.sqlite");

    expect(() =>
      manager.resolveDetailed(record.id, "allow-once", {
        kind: "device",
        id: "control-ui",
      }),
    ).toThrow();
    await expect(decisionPromise).resolves.toBe("deny");

    databaseOptions.path = validDatabasePath;
    vi.mocked(Date.now).mockReturnValue(2_000);
    expect(
      manager.resolveDetailed(record.id, "allow-once", {
        kind: "device",
        id: "control-ui",
      }),
    ).toMatchObject({ outcome: "already-resolved", retry: "conflict" });
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "denied",
      decision: "deny",
      terminalReason: "storage-corrupt",
    });

    vi.mocked(Date.now).mockReturnValue(100_000);
    expect(manager.getSnapshot(record.id)).toMatchObject({
      decision: "deny",
      terminalReason: "storage-corrupt",
    });
  });

  it("publishes durable expiry when storage recovery crosses the deadline", async () => {
    installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const lifecycleEvents: OperatorApprovalLifecycleEvent[] = [];
    const { manager, databaseOptions, dir } = createPersistentManager({
      onLifecycle: (event) => lifecycleEvents.push(event),
    });
    const record = manager.create(
      { command: "echo expiry" },
      1_000,
      "approval-storage-recovery-expiry",
    );
    const decisionPromise = manager.register(record, 1_000);
    const validDatabasePath = databaseOptions.path;
    const blocker = path.join(dir, "expiry-storage-blocker");
    fs.writeFileSync(blocker, "blocked");
    databaseOptions.path = path.join(blocker, "state.sqlite");

    expect(() =>
      manager.resolveDetailed(record.id, "allow-once", {
        kind: "device",
        id: "control-ui",
      }),
    ).toThrow();
    await expect(decisionPromise).resolves.toBe("deny");

    databaseOptions.path = validDatabasePath;
    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);
    expect(
      manager.resolveDetailed(record.id, "allow-once", {
        kind: "device",
        id: "control-ui",
      }),
    ).toMatchObject({ outcome: "expired", record: { status: "expired" } });
    expect(lifecycleEvents.map((event) => event.phase)).toEqual(["pending", "terminal"]);
    expect(lifecycleEvents[1]?.record).toMatchObject({
      status: "expired",
      terminalReason: "timeout",
    });
  });

  it("reconciles a durable terminal row into the existing local waiter", async () => {
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-reconcile");
    const decisionPromise = manager.register(record, 60_000);
    const resolved = resolveOperatorApproval({
      id: record.id,
      decision: "allow-once",
      resolver: { kind: "device", id: "control-ui" },
      expectedKind: "exec",
      runtimeEpoch: "runtime-a",
      databaseOptions,
    });
    if (resolved.outcome !== "resolved") {
      throw new Error(`expected durable resolution, received ${resolved.outcome}`);
    }

    expect(
      manager.reconcileDurableLookup({ outcome: "found", record: resolved.record }, "Control UI"),
    ).toBe(resolved.record);
    await expect(decisionPromise).resolves.toBe("allow-once");
    expect(manager.getLiveSnapshot(record.id)).toMatchObject({
      decision: "allow-once",
      resolvedBy: "Control UI",
    });
  });

  it("fails an existing waiter closed when durable lookup is missing", async () => {
    const { manager } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-missing");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.reconcileDurableLookup({ outcome: "missing", id: record.id })).toBeNull();
    await expect(decisionPromise).resolves.toBe("deny");
    expect(manager.getSnapshot(record.id)).toMatchObject({
      decision: "deny",
      terminalReason: "storage-corrupt",
    });
  });

  it("repairs a recovered pending row before stable read returns it", async () => {
    installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager, databaseOptions, dir } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-read-recover");
    const decisionPromise = manager.register(record, 60_000);
    const validDatabasePath = databaseOptions.path;
    const blocker = path.join(dir, "read-recovery-blocker");
    fs.writeFileSync(blocker, "blocked");
    databaseOptions.path = path.join(blocker, "state.sqlite");
    expect(() =>
      manager.resolveDetailed(record.id, "allow-once", {
        kind: "device",
        id: "control-ui",
      }),
    ).toThrow();
    await expect(decisionPromise).resolves.toBe("deny");

    databaseOptions.path = validDatabasePath;
    vi.mocked(Date.now).mockReturnValue(2_000);
    const pending = getOperatorApproval({ id: record.id, databaseOptions });
    if (!pending) {
      throw new Error("expected durable pending approval");
    }
    expect(pending.status).toBe("pending");
    expect(manager.reconcileDurableLookup({ outcome: "found", record: pending })).toMatchObject({
      status: "denied",
      terminalReason: "storage-corrupt",
    });
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "denied",
      terminalReason: "storage-corrupt",
    });
  });

  it("consumes allow-once durably without erasing the winning decision", () => {
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-consume");
    void manager.register(record, 60_000);
    manager.resolveDetailed(record.id, "allow-once", { kind: "device", id: "control-ui" });

    expect(manager.consumeAllowOnce(record.id, "system.run:approval-consume")).toBe(true);
    expect(manager.consumeAllowOnce(record.id, "system.run:approval-consume")).toBe(false);
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      consumedBy: "system.run:approval-consume",
    });
  });

  it("refuses allow-once redemption after the live grace window", () => {
    installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-grace");
    void manager.register(record, 60_000);
    manager.resolveDetailed(record.id, "allow-once", { kind: "device", id: "control-ui" });
    vi.mocked(Date.now).mockReturnValue(16_001);

    expect(manager.getSnapshot(record.id)).toBeNull();
    expect(manager.consumeAllowOnce(record.id)).toBe(false);
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      decision: "allow-once",
      consumedAtMs: null,
    });
  });

  it("uses fresh store time when redemption crosses the exact grace boundary", () => {
    installTimerMocks();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-store-grace");
    void manager.register(record, 60_000);
    manager.resolveDetailed(record.id, "allow-once", { kind: "device", id: "control-ui" });
    now.mockReturnValueOnce(15_999).mockReturnValue(16_000);

    expect(manager.consumeAllowOnce(record.id)).toBe(false);
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      decision: "allow-once",
      consumedAtMs: null,
    });
  });

  it("never rehydrates executable ownership from the durable record", () => {
    const timers = installTimerMocks();
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-epoch");
    record.requestedByDeviceId = "device-owner";
    void manager.register(record, 60_000);
    manager.resolveDetailed(record.id, "allow-once", { kind: "device", id: "control-ui" });

    const sameEpochManager = new ExecApprovalManager<{ command: string }>({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "runtime-a", databaseOptions },
    });
    const durable = getOperatorApproval({ id: record.id, databaseOptions });
    if (!durable) {
      throw new Error("expected durable approval");
    }
    expect(manager.getSnapshot(record.id)).toMatchObject({
      decision: "allow-once",
      requestedByDeviceId: "device-owner",
    });
    expect(sameEpochManager.getSnapshot(record.id)).toBeNull();
    expect(sameEpochManager.reconcileDurableLookup({ outcome: "found", record: durable })).toBe(
      durable,
    );
    expect(sameEpochManager.getLiveSnapshot(record.id)).toBeNull();
    expect(sameEpochManager.consumeAllowOnce(record.id)).toBe(false);

    runTimer(timers.find((timer) => timer.delay === 15_000));
    expect(manager.getSnapshot(record.id)).toBeNull();
    expect(manager.consumeAllowOnce(record.id)).toBe(false);
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
      decision: "allow-once",
      consumedAtMs: null,
    });
  });
});
