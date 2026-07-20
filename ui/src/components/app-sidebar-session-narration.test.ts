import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { SidebarSessionNarrationController } from "./app-sidebar-session-narration.ts";
import { deriveSidebarNarrationLine } from "./sidebar-narration-line.ts";

// Mirrors the controller-internal throttle; asserting through timers keeps the
// constant unexported (production-only export policy).
const SIDEBAR_NARRATION_THROTTLE_MS = 2_000;
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

function runningRow(key: string): SidebarRecentSession {
  return {
    key,
    label: "Run",
    meta: "now",
    href: "#",
    active: false,
    visuallyActive: false,
    hasActiveRun: true,
    modelSelectionLocked: false,
    pinned: false,
    cloudWorkerActive: false,
    hasAutomation: false,
    hasOpenPullRequest: false,
    unread: false,
    attention: { kind: "none" },
    startedAt: 1,
    childSessionKeys: [],
    children: [],
    isChild: false,
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
  };
}

function gatewayEvent(eventName: string, payload: unknown): GatewayEventFrame {
  return { event: eventName, payload } as GatewayEventFrame;
}

describe("sidebar narration derivation", () => {
  it("uses the last paragraph and sentence while removing markdown", () => {
    expect(
      deriveSidebarNarrationLine(
        "# Plan\n\nFirst **check** finished.\n\n```ts\nconst answer = 1;\n```\nFinal _verification_ is running.",
      ),
    ).toBe("Final verification is running.");
  });

  it("collapses whitespace and ellipsizes long fragments", () => {
    const line = deriveSidebarNarrationLine(`Earlier.\n\n- ${"result ".repeat(30)}`);
    expect(line).toHaveLength(120);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("  ");
  });
});

describe("SidebarSessionNarrationController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    // isolate:false shares the worker clock: a leaked fake timer deterministically
    // times out unrelated later files (seen: chat-background-tasks 60s hangs).
    vi.useRealTimers();
  });

  it("publishes assistant commentary and throttles a newer tool signal", async () => {
    const subscribeMessages = vi.fn(() =>
      Promise.resolve({ key: "agent:main:run", agentId: null }),
    );
    const unsubscribeMessages = vi.fn(() => Promise.resolve());
    const source = { subscribeMessages, unsubscribeMessages } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    const connectionIdentity = {};
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity,
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });
    await Promise.resolve();

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { phase: "commentary", text: "**Reading** files.", delta: "**Reading** files." },
      }),
    );
    controller.handleEvent(
      gatewayEvent("session.tool", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "tool",
        data: { phase: "start", name: "read" },
      }),
    );

    expect(updates.at(-1)?.get("agent:main:run")).toBe("Reading files.");
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS - 1);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Reading files.");
    await vi.advanceTimersByTimeAsync(1);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Using read");

    controller.disconnect();
    expect(unsubscribeMessages).toHaveBeenCalledWith({
      key: "agent:main:run",
      agentId: null,
    });
    expect(updates.at(-1)?.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("seeds a mid-run chat subscription from the cumulative message snapshot", () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        state: "delta",
        deltaText: "les now.",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Reading files now." }],
        },
      }),
    );

    expect(updates.at(-1)?.get("agent:main:run")).toBe("Reading files now.");
  });

  it("normalizes raw assistant events before publishing narration", () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: {
          text: [
            "Visible work is complete.",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "private runtime details",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
            "[[audio_as_voice]]",
            "REPLY_SKIP",
          ].join("\n"),
        },
      }),
    );

    expect(updates.at(-1)?.get("agent:main:run")).toBe("Visible work is complete.");
  });

  it("removes a trailing heartbeat token from a mixed visible response", () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: {
          text: `${"Visible progress continues. ".repeat(16)}Final visible status. HEARTBEAT_OK`,
        },
      }),
    );

    const line = updates.at(-1)?.get("agent:main:run");
    expect(line).toBe("Final visible status.");
    expect(line).not.toContain("HEARTBEAT_OK");
  });

  it("keeps a truncated internal block hidden until its closing delimiter arrives", async () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: {
          text: `Visible setup.\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${"private runtime detail ".repeat(1_000)}`,
        },
      }),
    );
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Visible setup.");

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { delta: "\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nFinal bounded line." },
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);

    expect(updates.at(-1)?.get("agent:main:run")).toBe("Final bounded line.");
  });

  it("holds a partial internal delimiter until its next fragment proves the boundary", () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { text: "Visible setup.\n<<<BEGIN_OPENCLAW_INTERNAL_CONT" },
      }),
    );
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Visible setup.");

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { delta: "EXT>>>\nprivate runtime detail" },
      }),
    );
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Visible setup.");
  });

  it("resets internal streaming state when a chat replacement is followed by deltas", async () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        state: "delta",
        deltaText: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate runtime text",
      }),
    );
    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        state: "delta",
        replace: true,
        deltaText: "Replacement",
      }),
    );
    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        state: "delta",
        deltaText: " now.",
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);

    expect(updates.at(-1)?.get("agent:main:run")).toBe("Replacement now.");
  });

  it("keeps an outer internal block hidden after its opening delimiter leaves the raw buffer", async () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: {
          text: [
            "Visible setup.",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "private outer runtime detail ".repeat(1_000),
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "private nested runtime detail ".repeat(1_000),
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        },
      }),
    );
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Visible setup.");

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { delta: "\nStill private after the nested block." },
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Visible setup.");

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { delta: "\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nFinal public line." },
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);

    expect(updates.at(-1)?.get("agent:main:run")).toBe("Final public line.");
  });

  it("replaces stale assistant narration when an agent event requests replacement", async () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { text: "Draft answer." },
      }),
    );
    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { replace: true, text: "Corrected answer." },
      }),
    );

    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Corrected answer.");
  });

  it("stays silent on a mid-run join until a cumulative snapshot aligns the stream", async () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    // First observed event is a bare delta: it could be the inside of an
    // internal-context block whose opening delimiter predates the join.
    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        deltaText: "secret internal continuation.",
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(updates.at(-1)?.has("agent:main:run") ?? false).toBe(false);

    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        deltaText: " Visible update.",
        message: { role: "assistant", content: "Public progress line. Visible update." },
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Visible update.");
  });

  it("retracts the shown line when a chat replacement is empty", async () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        deltaText: "Queued draft that gets withdrawn.",
        message: { role: "assistant", content: "Queued draft that gets withdrawn." },
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Queued draft that gets withdrawn.");

    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        deltaText: "",
        replace: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(updates.at(-1)?.has("agent:main:run")).toBe(false);
  });

  it("retracts the shown line when a replacement reduces to suppressed content", async () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { text: "Draft that gets withdrawn." },
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Draft that gets withdrawn.");

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { replace: true, text: "HEARTBEAT_OK" },
      }),
    );
    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "assistant",
        data: { replace: true, text: "" },
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(updates.at(-1)?.has("agent:main:run")).toBe(false);
  });

  it("does not let a stale subscribe completion remove replacement ownership", async () => {
    const completions: Array<{
      resolve: (subscription: { key: string; agentId: null }) => void;
      promise: Promise<{ key: string; agentId: null }>;
    }> = [];
    const subscribeMessages = vi.fn(() => {
      let resolve!: (subscription: { key: string; agentId: null }) => void;
      const promise = new Promise<{ key: string; agentId: null }>((resolvePromise) => {
        resolve = resolvePromise;
      });
      completions.push({ resolve, promise });
      return promise;
    });
    const unsubscribeMessages = vi.fn(() => Promise.resolve());
    const source = { subscribeMessages, unsubscribeMessages } as unknown as SessionCapability;
    const controller = new SidebarSessionNarrationController(() => undefined);
    const base = {
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      openSessionKey: "",
      agentId: "main",
    };

    controller.sync({ ...base, rows: [runningRow("agent:main:run")] });
    controller.sync({ ...base, rows: [] });
    controller.sync({ ...base, rows: [runningRow("agent:main:run")] });
    expect(subscribeMessages).toHaveBeenCalledTimes(2);

    completions[1]?.resolve({ key: "agent:main:run", agentId: null });
    await Promise.resolve();
    completions[0]?.resolve({ key: "agent:main:run", agentId: null });
    await Promise.resolve();

    expect(unsubscribeMessages).not.toHaveBeenCalled();
    controller.disconnect();
    expect(unsubscribeMessages).toHaveBeenCalledTimes(1);
  });

  it("rebinds an active global session when the selected agent changes", async () => {
    const subscribeMessages = vi.fn((key: string, options?: { agentId?: string | null }) =>
      Promise.resolve({ key, agentId: options?.agentId ?? null }),
    );
    const unsubscribeMessages = vi.fn(() => Promise.resolve());
    const source = { subscribeMessages, unsubscribeMessages } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    const base = {
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("global")],
      openSessionKey: "",
    };

    controller.sync({ ...base, agentId: "main" });
    await Promise.resolve();
    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "global",
        agentId: "main",
        state: "delta",
        deltaText: "Old agent work.",
        message: { role: "assistant", content: "Old agent work." },
      }),
    );
    expect(updates.at(-1)?.get("global")).toBe("Old agent work.");

    controller.sync({ ...base, agentId: "research" });
    await Promise.resolve();

    expect(unsubscribeMessages).toHaveBeenCalledWith({ key: "global", agentId: "main" });
    expect(subscribeMessages).toHaveBeenLastCalledWith("global", { agentId: "research" });
    expect(updates.at(-1)?.has("global")).toBe(false);
  });

  it("resets accumulated deltas when a new run starts for the same session", () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "first",
        state: "delta",
        deltaText: "Unfinished old work",
        message: { role: "assistant", content: "Unfinished old work" },
      }),
    );
    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "second",
        state: "delta",
        deltaText: "New run work.",
        message: { role: "assistant", content: "New run work." },
      }),
    );

    expect(updates.at(-1)?.get("agent:main:run")).toBe("New run work.");
  });

  it("cleans up a pending subscription after a same-connection source swap", async () => {
    let resolveFirst!: (subscription: { key: string; agentId: null }) => void;
    const firstSource = {
      subscribeMessages: vi.fn(
        () =>
          new Promise<{ key: string; agentId: null }>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const secondSource = {
      subscribeMessages: vi.fn(),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const controller = new SidebarSessionNarrationController(() => undefined);
    const connectionIdentity = {};

    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity,
      source: firstSource,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity,
      source: secondSource,
      rows: [],
      openSessionKey: "",
      agentId: "main",
    });
    resolveFirst({ key: "agent:main:run", agentId: null });
    await Promise.resolve();

    expect(firstSource.unsubscribeMessages).toHaveBeenCalledWith({
      key: "agent:main:run",
      agentId: null,
    });
  });

  it("does not hand an old agent's global subscription to the open chat", async () => {
    const subscribeMessages = vi.fn((key: string, options?: { agentId?: string | null }) =>
      Promise.resolve({ key, agentId: options?.agentId ?? null }),
    );
    const unsubscribeMessages = vi.fn(() => Promise.resolve());
    const source = { subscribeMessages, unsubscribeMessages } as unknown as SessionCapability;
    const controller = new SidebarSessionNarrationController(() => undefined);
    const base = {
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("global")],
    };

    controller.sync({ ...base, openSessionKey: "", agentId: "main" });
    await Promise.resolve();
    controller.sync({ ...base, openSessionKey: "global", agentId: "research" });

    expect(unsubscribeMessages).toHaveBeenCalledWith({ key: "global", agentId: "main" });
  });

  it("keeps the newest sentence after a response exceeds the retained tail", async () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    } as unknown as SessionCapability;
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });

    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "long",
        state: "delta",
        deltaText: `Preamble ${"x".repeat(20_000)}`,
        message: { role: "assistant", content: `Preamble ${"x".repeat(20_000)}` },
      }),
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "long",
        state: "delta",
        deltaText: ". Final bounded line.",
        message: {
          role: "assistant",
          content: `Preamble ${"x".repeat(20_000)}. Final bounded line.`,
        },
      }),
    );

    expect(updates.at(-1)?.get("agent:main:run")).toBe("Final bounded line.");
  });
});
