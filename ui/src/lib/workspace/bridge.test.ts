import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWidgetBridge, type WidgetOutboundMessage } from "./bridge.ts";
import type { WidgetManifestView } from "./types.ts";

type WidgetBridgeDeps = Parameters<typeof createWidgetBridge>[0];

let testWidgetSequence = 0;

beforeEach(() => {
  testWidgetSequence += 1;
});

function manifest(overrides?: Partial<WidgetManifestView>): WidgetManifestView {
  return {
    name: `revenue-chart-${testWidgetSequence}`,
    frameToken: "11111111-1111-4111-8111-111111111111",
    entrypoint: "index.html",
    bindings: { value: { source: "static", value: null } },
    capabilities: ["data:read"],
    ...overrides,
  };
}

function makeBridge(overrides?: Partial<WidgetBridgeDeps>) {
  const posted: WidgetOutboundMessage[] = [];
  const deps: WidgetBridgeDeps = {
    manifest: manifest(),
    resolveBinding: async () => ({ ok: true }),
    resolveTheme: () => ({ "--accent": "#ff0000" }),
    confirmPrompt: async () => true,
    sendPrompt: async () => undefined,
    post: (message) => posted.push(message),
    ...overrides,
  };
  return { bridge: createWidgetBridge(deps), posted };
}

describe("createWidgetBridge accept filter", () => {
  it("drops malformed messages and counts them", () => {
    const { bridge } = makeBridge();
    expect(bridge.handleMessage({ v: 2, type: "workspace:ready" })).toBe(false);
    expect(bridge.handleMessage({ type: "workspace:getData" })).toBe(false);
    expect(bridge.handleMessage("garbage")).toBe(false);
    expect(bridge.droppedCount).toBe(3);
  });

  it("accepts a ready handshake", () => {
    const { bridge } = makeBridge();
    expect(bridge.handleMessage({ v: 1, type: "workspace:ready" })).toBe(true);
    expect(bridge.droppedCount).toBe(0);
  });
});

describe("getData binding gating", () => {
  it("denies data access when data:read was not approved", async () => {
    const resolveBinding = vi.fn(async () => ({ ok: true }));
    const { bridge, posted } = makeBridge({
      manifest: manifest({ capabilities: [] }),
      resolveBinding,
    });
    bridge.handleMessage({ v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: "workspace:error", code: "capability_denied" });
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("resolves a declared binding and posts data", async () => {
    const { bridge, posted } = makeBridge({ resolveBinding: async () => ({ revenue: 42 }) });
    bridge.handleMessage({ v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      v: 1,
      type: "workspace:data",
      requestId: "r1",
      bindingId: "value",
      data: { revenue: 42 },
    });
  });

  it("denies an undeclared binding with binding_denied and never calls the resolver", async () => {
    const resolveBinding = vi.fn(async () => ({ ok: true }));
    const { bridge, posted } = makeBridge({ resolveBinding });
    bridge.handleMessage({ v: 1, type: "workspace:getData", requestId: "r1", bindingId: "secret" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      type: "workspace:error",
      code: "binding_denied",
      requestId: "r1",
    });
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("posts a timeout error when the resolver overruns getDataTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, posted } = makeBridge({
        getDataTimeoutMs: 10_000,
        resolveBinding: () => new Promise(() => {}),
      });
      bridge.handleMessage({
        v: 1,
        type: "workspace:getData",
        requestId: "r1",
        bindingId: "value",
      });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(posted[0]).toMatchObject({
        type: "workspace:error",
        code: "timeout",
        requestId: "r1",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getTheme", () => {
  it("returns the theme tokens", () => {
    const { bridge, posted } = makeBridge({ resolveTheme: () => ({ "--bg": "#000" }) });
    bridge.handleMessage({ v: 1, type: "workspace:getTheme", requestId: "t1" });
    expect(posted[0]).toEqual({
      v: 1,
      type: "workspace:theme",
      requestId: "t1",
      tokens: { "--bg": "#000" },
    });
  });
});

describe("sendPrompt capability + confirm + rate limit", () => {
  it("denies without a dialog when the capability is absent", async () => {
    const confirmPrompt = vi.fn(async () => true);
    const sendPrompt = vi.fn(async () => undefined);
    const { bridge, posted } = makeBridge({
      manifest: manifest({ capabilities: ["data:read"] }),
      confirmPrompt,
      sendPrompt,
    });
    bridge.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: "p1", text: "hi" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: "workspace:error", code: "capability_denied" });
    expect(confirmPrompt).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("shows the dialog and sends nothing when the operator declines", async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const { bridge, posted } = makeBridge({
      manifest: manifest({ capabilities: ["data:read", "prompt:send"] }),
      confirmPrompt: async () => false,
      sendPrompt,
    });
    bridge.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: "p1", text: "hi" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: "workspace:error", code: "prompt_declined" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("sends exactly once when the operator confirms", async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const confirmPrompt = vi.fn(async () => true);
    const { bridge } = makeBridge({
      manifest: manifest({ capabilities: ["prompt:send"] }),
      confirmPrompt,
      sendPrompt,
    });
    bridge.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: "p1", text: "do it" });
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(confirmPrompt).toHaveBeenCalledWith("do it");
    expect(sendPrompt).toHaveBeenCalledWith("do it");
  });

  it("rate-limits to at most one in-flight prompt", async () => {
    let resolveConfirm!: (ok: boolean) => void;
    const { bridge, posted } = makeBridge({
      manifest: manifest({ capabilities: ["prompt:send"] }),
      confirmPrompt: () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    });
    bridge.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: "p1", text: "one" });
    // Second request while the first confirm is still pending → rate_limited.
    bridge.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: "p2", text: "two" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      type: "workspace:error",
      code: "rate_limited",
      requestId: "p2",
    });
    resolveConfirm(false);
  });

  it("rate-limits to 10 sends per minute", async () => {
    const clock = 0;
    let sent = 0;
    const { bridge, posted } = makeBridge({
      manifest: manifest({ capabilities: ["prompt:send"] }),
      confirmPrompt: async () => true,
      sendPrompt: async () => {
        sent += 1;
      },
      now: () => clock,
    });
    // Fire sequentially, awaiting each send so `promptInFlight` clears before the
    // next (the in-flight limit is exercised by a separate test).
    for (let i = 0; i < 10; i += 1) {
      bridge.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: `p${i}`, text: "x" });
      await vi.waitFor(() => expect(sent).toBe(i + 1));
    }
    expect(posted).toHaveLength(0);
    // The 11th within the same rolling minute is rejected.
    bridge.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: "p10", text: "x" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: "workspace:error", code: "rate_limited" });
    expect(sent).toBe(10);
  });
});

describe("push", () => {
  it("posts a push for a declared binding", async () => {
    const { bridge, posted } = makeBridge({ resolveBinding: async () => 7 });
    await bridge.push("value");
    expect(posted[0]).toEqual({ v: 1, type: "workspace:push", bindingId: "value", data: 7 });
  });

  it("ignores a push for an undeclared binding", async () => {
    const { bridge, posted } = makeBridge();
    await bridge.push("secret");
    expect(posted).toHaveLength(0);
  });

  it("ignores a push when data:read was not approved", async () => {
    const resolveBinding = vi.fn(async () => 7);
    const { bridge, posted } = makeBridge({
      manifest: manifest({ capabilities: [] }),
      resolveBinding,
    });
    await bridge.push("value");
    expect(posted).toHaveLength(0);
    expect(resolveBinding).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("stops handling messages after dispose", () => {
    const { bridge } = makeBridge();
    bridge.dispose();
    expect(bridge.handleMessage({ v: 1, type: "workspace:ready" })).toBe(false);
  });
});

describe("rate-limit state persists across bridge re-instantiation (remount)", () => {
  // Exhaust the per-minute budget on one bridge, then dispose + recreate a fresh
  // bridge for the SAME widget name (simulating an iframe remount) and assert the
  // budget did NOT reset — the next send is still rate_limited within the window.
  it("keeps the budget for the same widget name after dispose + recreate", async () => {
    const clock = 1_000_000;
    let sent = 0;
    const makeNamed = () => {
      const posted: WidgetOutboundMessage[] = [];
      const bridge = createWidgetBridge({
        manifest: manifest({ name: "remount-widget", capabilities: ["prompt:send"] }),
        resolveBinding: async () => null,
        resolveTheme: () => ({}),
        confirmPrompt: async () => true,
        sendPrompt: async () => {
          sent += 1;
        },
        post: (message) => posted.push(message),
        now: () => clock,
      });
      return { bridge, posted };
    };

    const first = makeNamed();
    for (let i = 0; i < 10; i += 1) {
      first.bridge.handleMessage({
        v: 1,
        type: "workspace:sendPrompt",
        requestId: `a${i}`,
        text: "x",
      });
      await vi.waitFor(() => expect(sent).toBe(i + 1));
    }
    // Remount: dispose the exhausted bridge and build a fresh one for the same name.
    first.bridge.dispose();
    const second = makeNamed();
    second.bridge.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: "b0", text: "x" });
    await vi.waitFor(() => expect(second.posted).toHaveLength(1));
    // Budget survived the remount → still rate_limited, no extra send.
    expect(second.posted[0]).toMatchObject({ type: "workspace:error", code: "rate_limited" });
    expect(sent).toBe(10);
  });

  it("gives a DIFFERENT widget name its own independent budget", async () => {
    const clock = 2_000_000;
    let sentA = 0;
    let sentB = 0;
    const bridgeA = createWidgetBridge({
      manifest: manifest({ name: "widget-a", capabilities: ["prompt:send"] }),
      resolveBinding: async () => null,
      resolveTheme: () => ({}),
      confirmPrompt: async () => true,
      sendPrompt: async () => {
        sentA += 1;
      },
      post: () => {},
      now: () => clock,
    });
    const postedB: WidgetOutboundMessage[] = [];
    const bridgeB = createWidgetBridge({
      manifest: manifest({ name: "widget-b", capabilities: ["prompt:send"] }),
      resolveBinding: async () => null,
      resolveTheme: () => ({}),
      confirmPrompt: async () => true,
      sendPrompt: async () => {
        sentB += 1;
      },
      post: (message) => postedB.push(message),
      now: () => clock,
    });
    // Exhaust widget-a's budget.
    for (let i = 0; i < 10; i += 1) {
      bridgeA.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: `a${i}`, text: "x" });
      await vi.waitFor(() => expect(sentA).toBe(i + 1));
    }
    // widget-b is unaffected — its first send succeeds.
    bridgeB.handleMessage({ v: 1, type: "workspace:sendPrompt", requestId: "b0", text: "x" });
    await vi.waitFor(() => expect(sentB).toBe(1));
    expect(postedB).toHaveLength(0);
  });
});

describe("resolve-time binding re-check", () => {
  it("does not push a binding the gate denies (never calls resolveBinding)", async () => {
    const resolveBinding = vi.fn(async () => 1);
    const { bridge, posted } = makeBridge({
      resolveBinding,
      assertBindingAllowed: () => "binding_denied",
    });
    await bridge.push("value");
    expect(posted).toHaveLength(0);
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("allows a getData when the gate returns null", async () => {
    const resolveBinding = vi.fn(async () => 42);
    const { bridge, posted } = makeBridge({
      resolveBinding,
      assertBindingAllowed: () => null,
    });
    bridge.handleMessage({ v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: "workspace:data", data: 42 });
    expect(resolveBinding).toHaveBeenCalledOnce();
  });
});
