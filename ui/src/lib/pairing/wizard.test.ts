import { describe, expect, it, vi } from "vitest";
import type { PairingEndpointProbeResult } from "./endpoint-probe.ts";
import { createPairingWizard, type PairingWizardStep } from "./wizard.ts";

const LAN_URL = "ws://192.168.1.20:18789";
const CONFIG_HASH = "a".repeat(64);

const readyInspection = {
  configHash: CONFIG_HASH,
  configState: "applied",
  auth: "token",
  current: {
    status: "ready",
    urls: ["wss://gateway.example.com"],
    source: "remote",
    exposure: "public-internet",
    access: "full",
    accessDowngraded: false,
  },
  lan: { status: "available", url: LAN_URL, requiresGatewayChange: true },
  tailscale: { status: "unavailable" },
  publicUrl: { status: "not-configured" },
};

const loopbackInspection = {
  ...readyInspection,
  current: { status: "blocked", blocker: "route-unavailable" },
};

const lanPlan = {
  status: "confirmation-required",
  mode: "lan",
  configHash: CONFIG_HASH,
  configState: "applied",
  urls: [LAN_URL],
  exposure: "local-network",
  auth: "token",
  access: "limited",
  accessDowngraded: true,
  changes: ["expose-gateway-on-local-network"],
  configWrite: {
    patch: '{"gateway":{"bind":"lan"}}',
    revert: { execution: "automatic", patch: '{"gateway":{"bind":"loopback"}}' },
  },
  restartRequired: true,
  preservesCurrentRoute: false,
};

const appliedLanPlan = {
  ...lanPlan,
  changes: [],
  restartRequired: false,
  preservesCurrentRoute: true,
  configWrite: undefined,
};

const TAILNET_URL = "wss://gateway.tail1a2b.ts.net";

const tailscalePlan = {
  status: "confirmation-required",
  mode: "tailscale",
  configHash: CONFIG_HASH,
  configState: "applied",
  urls: [TAILNET_URL],
  exposure: "tailnet",
  auth: "token",
  access: "full",
  accessDowngraded: false,
  changes: [],
  restartRequired: false,
  preservesCurrentRoute: true,
};

const blockedTailscalePlan = {
  status: "blocked",
  mode: "tailscale",
  configHash: CONFIG_HASH,
  configState: "applied",
  auth: "token",
  blocker: "tailscale-serve-required",
  changes: [],
  action: { kind: "retry", target: "gateway-host", execution: "manual", resumable: true },
};

const tailnetSetupCode = {
  setupCode: "SETUP-CODE",
  gatewayUrl: TAILNET_URL,
  auth: "token",
  urlSource: "gateway.tailscale.mode=serve",
  access: "full",
  accessDowngraded: false,
};

function setupCodeFor(gatewayUrl: string) {
  return {
    setupCode: "SETUP-CODE",
    gatewayUrl,
    auth: "token",
    urlSource: "gateway.bind=lan",
    access: "limited",
    accessDowngraded: true,
  };
}

const setupCode = setupCodeFor(LAN_URL);
const remoteSetupCode = setupCodeFor("wss://gateway.example.com");

/** Static payload or a factory when a case needs to control settle timing. */
type Responses = Record<string, unknown>;

function createHarness(
  options: {
    responses?: Responses;
    probe?: (url: string) => Promise<PairingEndpointProbeResult>;
    hash?: string | null;
    patch?: (params: { raw: string; note: string }) => Promise<boolean>;
    canProve?: (url: string) => boolean;
    restartGraceMs?: number;
  } = {},
) {
  const responses: Responses = {
    "device.pair.connectivity.inspect": loopbackInspection,
    "device.pair.connectivity.plan": lanPlan,
    "device.pair.setupCode": setupCode,
    ...options.responses,
  };
  const calls: Array<{ method: string; params?: unknown }> = [];
  const client = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      const response = responses[method];
      if (response === undefined) {
        throw new Error(`unexpected method ${method}`);
      }
      return (await (typeof response === "function"
        ? (response as () => unknown)()
        : response)) as T;
    },
  };
  const patch = options.patch ?? vi.fn(async () => true);
  // Mirrors the runtime capability: the drain hook stands in for pending
  // autosaves settling between the caller's check and the real dispatch.
  const config = {
    refresh: vi.fn(async () => {}),
    readHash: (): string | null => (options.hash === undefined ? CONFIG_HASH : options.hash),
    drainBeforeDispatch: () => {},
    patch: vi.fn(async (params: { raw: string; note: string; expectedHash: string }) => {
      config.drainBeforeDispatch();
      // The real capability rechecks the caller's guard here, after the drain.
      return config.readHash() === params.expectedHash ? await patch(params) : false;
    }),
    readError: () => "write rejected",
  };
  const harnessState = { probeResult: { status: "reachable" } as PairingEndpointProbeResult };
  const wizard = createPairingWizard({
    config,
    onChange: () => {},
    probe: options.probe ?? (async () => harnessState.probeResult),
    canProve: options.canProve ?? (() => true),
    // Long enough that only an explicit reconnect drives the restart step.
    restartGraceMs: options.restartGraceMs ?? 60_000,
  });
  wizard.setConnection({ client, connected: true });
  return {
    wizard,
    config,
    calls,
    set probeResult(next: PairingEndpointProbeResult) {
      harnessState.probeResult = next;
    },
    methods: () => calls.map((call) => call.method),
    paramsOf: (method: string) =>
      calls.filter((call) => call.method === method).map((c) => c.params),
    setResponse: (method: string, value: unknown) => {
      responses[method] = value;
    },
    disconnect: () => wizard.setConnection({ client: null, connected: false }),
    reconnect: () => wizard.setConnection({ client, connected: true }),
  };
}

function stepKind(step: PairingWizardStep) {
  return step.kind;
}

describe("pairing wizard", () => {
  it("opens a pairing-only operator into review instead of an admin inspection", async () => {
    const harness = createHarness();
    await harness.wizard.open({ canAdmin: false });

    expect(harness.wizard.snapshot.step).toEqual({ kind: "admin-required" });
    expect(harness.methods()).toEqual([]);
  });

  it("inspects on open without issuing a setup code", async () => {
    const harness = createHarness();
    await harness.wizard.open({ canAdmin: true });

    expect(stepKind(harness.wizard.snapshot.step)).toBe("chooser");
    expect(harness.methods()).toEqual(["device.pair.connectivity.inspect"]);
  });

  it("proves the current route before minting and adopts the issued access", async () => {
    const harness = createHarness({
      responses: {
        "device.pair.connectivity.inspect": readyInspection,
        "device.pair.setupCode": remoteSetupCode,
      },
    });
    await harness.wizard.open({ canAdmin: true });
    harness.wizard.setAccess("limited");
    await harness.wizard.chooseRoute("current");

    expect(harness.wizard.snapshot.step).toEqual({ kind: "code", setup: remoteSetupCode });
    expect(harness.wizard.snapshot.access).toBe("limited");
    expect(harness.paramsOf("device.pair.setupCode")).toEqual([{ bootstrapProfile: "limited" }]);
    expect(harness.config.patch).not.toHaveBeenCalled();
  });

  it("never mints when the browser cannot prove the current route", async () => {
    const harness = createHarness({
      responses: { "device.pair.connectivity.inspect": readyInspection },
      probe: async () => ({ status: "not-a-gateway" }),
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("current");

    expect(harness.wizard.snapshot.step).toEqual({
      kind: "recovery",
      reason: "endpoint-unproven",
    });
    expect(harness.methods()).not.toContain("device.pair.setupCode");
  });

  it("shows LAN consequences and writes nothing before confirmation", async () => {
    const harness = createHarness();
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");

    expect(harness.wizard.snapshot.step).toEqual({ kind: "lan-review", plan: lanPlan });
    expect(harness.config.patch).not.toHaveBeenCalled();
    expect(harness.methods()).not.toContain("device.pair.setupCode");
  });

  it("refuses the LAN change when this page could never verify it", async () => {
    const harness = createHarness({ canProve: (url) => !url.startsWith("ws://") });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");

    expect(harness.wizard.snapshot.step).toEqual({
      kind: "recovery",
      reason: "endpoint-unprovable",
    });
    expect(harness.config.patch).not.toHaveBeenCalled();
  });

  it("refuses to apply against a snapshot another writer moved", async () => {
    const harness = createHarness({ hash: "b".repeat(64) });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();

    expect(harness.wizard.snapshot.step).toEqual({ kind: "conflict" });
    expect(harness.config.refresh).toHaveBeenCalled();
    expect(harness.config.patch).not.toHaveBeenCalled();
  });

  it("refuses to dispatch after a queued write moves the snapshot", async () => {
    let hash = CONFIG_HASH;
    const dispatched: Array<{ raw: string }> = [];
    const harness = createHarness({
      // The writer drains pending autosaves before it dispatches; a drained
      // write can move the snapshot after the wizard's pre-flight check.
      patch: async (params) => {
        dispatched.push({ raw: params.raw });
        return true;
      },
    });
    harness.config.readHash = () => hash;
    harness.config.refresh = vi.fn(async () => {});
    harness.config.drainBeforeDispatch = () => {
      hash = "d".repeat(64);
    };
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();

    expect(dispatched).toEqual([]);
    expect(harness.wizard.snapshot.step).toEqual({ kind: "conflict" });
  });

  it("never writes for a plan the owner issued without a config hash", async () => {
    const { configHash: _omitted, ...hashlessPlan } = lanPlan;
    const harness = createHarness({
      responses: { "device.pair.connectivity.plan": hashlessPlan },
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();

    expect(harness.wizard.snapshot.step).toEqual({ kind: "conflict" });
    expect(harness.config.patch).not.toHaveBeenCalled();
  });

  it("applies the owner patch, survives the restart, then proves and mints", async () => {
    const harness = createHarness();
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();

    expect(harness.config.patch).toHaveBeenCalledWith({
      raw: '{"gateway":{"bind":"lan"}}',
      note: expect.any(String),
      expectedHash: CONFIG_HASH,
    });
    expect(stepKind(harness.wizard.snapshot.step)).toBe("awaiting-restart");

    harness.disconnect();
    expect(stepKind(harness.wizard.snapshot.step)).toBe("awaiting-restart");

    harness.setResponse("device.pair.connectivity.plan", appliedLanPlan);
    harness.reconnect();
    await vi.waitFor(() => expect(stepKind(harness.wizard.snapshot.step)).toBe("code"));
    expect(harness.paramsOf("device.pair.setupCode")).toEqual([{ mode: "lan" }]);
  });

  it("re-inspects a hot-applied change that never dropped the connection", async () => {
    const harness = createHarness({ restartGraceMs: 1 });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    harness.setResponse("device.pair.connectivity.plan", appliedLanPlan);
    await harness.wizard.confirmLan();

    await vi.waitFor(() => expect(stepKind(harness.wizard.snapshot.step)).toBe("code"));
  });

  it("reports a change the running Gateway has not adopted yet", async () => {
    const harness = createHarness();
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();
    harness.disconnect();
    harness.reconnect();

    await vi.waitFor(() =>
      expect(harness.wizard.snapshot.step).toEqual({
        kind: "recovery",
        reason: "restart-pending",
      }),
    );
  });

  it("reverts through a fresh snapshot when the new route cannot be proven", async () => {
    const harness = createHarness({ probe: async () => ({ status: "unreachable" }) });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();
    harness.setResponse("device.pair.connectivity.plan", appliedLanPlan);
    harness.disconnect();
    harness.reconnect();

    await vi.waitFor(() => expect(stepKind(harness.wizard.snapshot.step)).toBe("chooser"));
    expect(harness.wizard.snapshot.notice).toBe("route-reverted");
    expect(harness.config.patch).toHaveBeenLastCalledWith({
      raw: '{"gateway":{"bind":"loopback"}}',
      note: expect.any(String),
      expectedHash: CONFIG_HASH,
    });
    expect(harness.config.refresh).toHaveBeenCalledTimes(2);
  });

  it("hands a remote operator manual recovery instead of an inverse write", async () => {
    const manualPlan = {
      ...lanPlan,
      configWrite: { patch: lanPlan.configWrite.patch, revert: { execution: "manual" } },
    };
    const harness = createHarness({
      responses: { "device.pair.connectivity.plan": manualPlan },
      probe: async () => ({ status: "unreachable" }),
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();
    harness.setResponse("device.pair.connectivity.plan", appliedLanPlan);
    harness.disconnect();
    harness.reconnect();

    await vi.waitFor(() =>
      expect(harness.wizard.snapshot.step).toEqual({ kind: "recovery", reason: "revert-manual" }),
    );
    expect(harness.config.patch).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed revert as manual recovery", async () => {
    let writes = 0;
    const harness = createHarness({
      probe: async () => ({ status: "unreachable" }),
      patch: async () => {
        writes += 1;
        return writes === 1;
      },
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();
    harness.setResponse("device.pair.connectivity.plan", appliedLanPlan);
    harness.disconnect();
    harness.reconnect();

    await vi.waitFor(() =>
      expect(harness.wizard.snapshot.step).toEqual({ kind: "recovery", reason: "revert-failed" }),
    );
  });

  it.each([
    {
      name: "rejects a public URL the planner refuses",
      plan: {
        status: "blocked",
        mode: "public",
        configState: "applied",
        auth: "token",
        blocker: "public-url-insecure",
        changes: [],
      },
      probe: { status: "reachable" } as const,
      expected: "public-url-rejected",
    },
    {
      name: "keeps an unreachable public URL editable",
      plan: {
        status: "confirmation-required",
        mode: "public",
        configState: "applied",
        urls: ["wss://gateway.example.com"],
        exposure: "public-internet",
        auth: "token",
        access: "full",
        accessDowngraded: false,
        changes: [],
        restartRequired: false,
        preservesCurrentRoute: true,
      },
      probe: { status: "unreachable" } as const,
      expected: "public-url-unreachable",
    },
  ])("$name", async ({ plan, probe, expected }) => {
    const harness = createHarness({
      responses: { "device.pair.connectivity.plan": plan },
      probe: async () => probe,
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("public");
    harness.wizard.setPublicUrl("wss://gateway.example.com");
    await harness.wizard.submitPublicUrl();

    expect(stepKind(harness.wizard.snapshot.step)).toBe(expected);
    expect(harness.methods()).not.toContain("device.pair.setupCode");
    expect(harness.config.patch).not.toHaveBeenCalled();
  });

  it("passes a proven public URL one-shot and never persists it", async () => {
    const publicPlan = {
      status: "confirmation-required",
      mode: "public",
      configState: "applied",
      urls: ["wss://gateway.example.com"],
      exposure: "public-internet",
      auth: "token",
      access: "full",
      accessDowngraded: false,
      changes: [],
      restartRequired: false,
      preservesCurrentRoute: true,
    };
    const harness = createHarness({
      responses: {
        "device.pair.connectivity.plan": publicPlan,
        "device.pair.setupCode": remoteSetupCode,
      },
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("public");
    harness.wizard.setPublicUrl("wss://gateway.example.com");
    await harness.wizard.submitPublicUrl();

    expect(stepKind(harness.wizard.snapshot.step)).toBe("code");
    expect(harness.paramsOf("device.pair.setupCode")).toEqual([
      { mode: "public", publicUrl: "wss://gateway.example.com" },
    ]);
    expect(harness.config.patch).not.toHaveBeenCalled();
  });

  it("mints nothing while any advertised candidate stays silent", async () => {
    const reachable = "wss://reachable.example.com";
    const silent = "wss://silent.example.com";
    const harness = createHarness({
      responses: {
        "device.pair.connectivity.inspect": {
          ...readyInspection,
          current: { ...readyInspection.current, urls: [reachable, silent] },
        },
        "device.pair.setupCode": {
          ...setupCodeFor(reachable),
          gatewayUrls: [reachable, silent],
        },
      },
      probe: async (url) =>
        url === reachable ? { status: "reachable" } : { status: "not-a-gateway" },
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("current");

    expect(harness.wizard.snapshot.step).toEqual({
      kind: "recovery",
      reason: "endpoint-unproven",
    });
    expect(harness.methods()).not.toContain("device.pair.setupCode");
  });

  it("disarms the rollback once the applied route is proven", async () => {
    const harness = createHarness();
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();
    harness.setResponse("device.pair.connectivity.plan", appliedLanPlan);
    harness.disconnect();
    harness.reconnect();
    await vi.waitFor(() => expect(stepKind(harness.wizard.snapshot.step)).toBe("code"));

    // A later attempt whose probe fails must not undo the working route.
    harness.probeResult = { status: "unreachable" };
    await harness.wizard.back();
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();

    await vi.waitFor(() =>
      expect(harness.wizard.snapshot.step).toEqual({
        kind: "recovery",
        reason: "endpoint-unproven",
      }),
    );
    expect(harness.config.patch).toHaveBeenCalledTimes(1);
  });

  it("withholds a code the Gateway issued for a different address", async () => {
    const harness = createHarness({
      responses: {
        "device.pair.connectivity.inspect": readyInspection,
        // A configured device-pair public URL can outrank the chosen route.
        "device.pair.setupCode": setupCodeFor("wss://stale.example.com"),
      },
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("current");

    expect(harness.wizard.snapshot.step).toEqual({
      kind: "recovery",
      reason: "endpoint-mismatch",
    });
  });

  it("leaves a concurrent bind change alone instead of reverting over it", async () => {
    let hash = CONFIG_HASH;
    const harness = createHarness({ probe: async () => ({ status: "unreachable" }) });
    harness.config.readHash = () => hash;
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("lan");
    await harness.wizard.confirmLan();
    harness.setResponse("device.pair.connectivity.plan", appliedLanPlan);
    // Another writer moves the file while the probe runs.
    hash = "c".repeat(64);
    harness.disconnect();
    harness.reconnect();

    await vi.waitFor(() =>
      expect(harness.wizard.snapshot.step).toEqual({
        kind: "recovery",
        reason: "revert-conflict",
      }),
    );
    expect(harness.config.patch).toHaveBeenCalledTimes(1);
  });

  it("ignores a reply that belongs to a retired step", async () => {
    let releaseInspect: (value: unknown) => void = () => {};
    const pendingInspect = new Promise<unknown>((resolve) => {
      releaseInspect = resolve;
    });
    const harness = createHarness({
      responses: { "device.pair.connectivity.inspect": () => pendingInspect },
    });
    const opening = harness.wizard.open({ canAdmin: true });
    harness.wizard.close();
    releaseInspect(loopbackInspection);
    await opening;

    expect(harness.wizard.snapshot.open).toBe(false);
    expect(stepKind(harness.wizard.snapshot.step)).toBe("inspecting");
  });

  it("proves the tailnet route before minting and pins issuance to it", async () => {
    const harness = createHarness({
      responses: {
        "device.pair.connectivity.plan": tailscalePlan,
        "device.pair.setupCode": tailnetSetupCode,
      },
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("tailscale");

    expect(harness.wizard.snapshot.step).toEqual({ kind: "code", setup: tailnetSetupCode });
    expect(harness.methods()).toEqual([
      "device.pair.connectivity.inspect",
      "device.pair.connectivity.plan",
      "device.pair.setupCode",
    ]);
    expect(harness.paramsOf("device.pair.connectivity.plan")).toEqual([{ mode: "tailscale" }]);
    expect(harness.paramsOf("device.pair.setupCode")).toEqual([{ mode: "tailscale" }]);
    // An externally owned route is read, never written or restarted.
    expect(harness.config.patch).not.toHaveBeenCalled();
  });

  it("withholds a setup code when the tailnet route does not answer", async () => {
    const harness = createHarness({
      responses: { "device.pair.connectivity.plan": tailscalePlan },
      probe: async () => ({ status: "unreachable" }),
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("tailscale");

    expect(harness.wizard.snapshot.step).toEqual({ kind: "recovery", reason: "endpoint-unproven" });
    expect(harness.methods()).not.toContain("device.pair.setupCode");
    expect(harness.config.patch).not.toHaveBeenCalled();
  });

  it("re-plans from authoritative state once the host step is finished", async () => {
    const harness = createHarness({
      responses: { "device.pair.connectivity.plan": blockedTailscalePlan },
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("tailscale");

    expect(harness.wizard.snapshot.step).toEqual({ kind: "blocked", plan: blockedTailscalePlan });
    expect(harness.methods()).not.toContain("device.pair.setupCode");

    harness.setResponse("device.pair.connectivity.plan", tailscalePlan);
    harness.setResponse("device.pair.setupCode", tailnetSetupCode);
    await harness.wizard.chooseRoute("tailscale");

    expect(harness.wizard.snapshot.step).toEqual({ kind: "code", setup: tailnetSetupCode });
    expect(harness.paramsOf("device.pair.connectivity.plan")).toEqual([
      { mode: "tailscale" },
      { mode: "tailscale" },
    ]);
  });

  it("keeps the other routes usable while Tailscale is blocked", async () => {
    const harness = createHarness({
      responses: { "device.pair.connectivity.plan": blockedTailscalePlan },
    });
    await harness.wizard.open({ canAdmin: true });
    await harness.wizard.chooseRoute("tailscale");
    expect(stepKind(harness.wizard.snapshot.step)).toBe("blocked");

    await harness.wizard.back();
    expect(stepKind(harness.wizard.snapshot.step)).toBe("chooser");

    harness.setResponse("device.pair.connectivity.plan", lanPlan);
    await harness.wizard.chooseRoute("lan");

    expect(harness.wizard.snapshot.step).toEqual({ kind: "lan-review", plan: lanPlan });
  });
});
