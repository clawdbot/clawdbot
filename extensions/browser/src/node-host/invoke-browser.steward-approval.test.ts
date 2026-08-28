// Browser tests cover the node-host Browser Steward final-effect approval gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROXY_ERROR_ENVELOPE,
  BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
} from "../browser-proxy-envelope.js";
import { createBrowserStewardGatewayApproval } from "../browser/browser-steward-approval.js";

const mocks = vi.hoisted(() => ({
  closeTrackedCdpTarget: vi.fn<
    (params: { shouldClose?: () => boolean }) => Promise<{ status: "closed" }>
  >(async () => ({ status: "closed" })),
  dispatch: vi.fn(),
  startBrowserControlService: vi.fn(async () => true),
  loadConfig: vi.fn(() => ({
    browser: {},
    nodeHost: { browserProxy: { enabled: true, allowProfiles: [] as string[] } },
  })),
}));

vi.mock("../sdk-config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  getRuntimeConfigSourceSnapshot: () => null,
}));

vi.mock("../browser/config.js", () => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    defaultProfile: "openclaw",
    profiles: {
      openclaw: {
        name: "openclaw",
        driver: "openclaw",
        cdpUrl: "http://127.0.0.1:9222",
      },
    },
    remoteCdpTimeoutMs: 20_000,
    ssrfPolicy: undefined,
  })),
  resolveProfile: vi.fn(
    (resolved: { profiles?: Record<string, unknown> }, name: string) =>
      resolved.profiles?.[name] ?? null,
  ),
}));

vi.mock("../browser-proxy-upload.js", () => ({
  stageBrowserProxyUploadRequest: vi.fn(async ({ body }: { body: unknown }) => ({ body })),
  discardStagedBrowserProxyUpload: vi.fn(async () => undefined),
  ensureBrowserProxyUploadCleanup: vi.fn(async () => undefined),
}));

vi.mock("../browser/request-policy.js", () => ({
  isPersistentBrowserProfileMutation: vi.fn(() => false),
  isBrowserHostLocalRoute: vi.fn(() => false),
  normalizeBrowserRequestPath: vi.fn((path: string) => path),
  resolveRequestedBrowserProfile: vi.fn(({ profile }: { profile?: string }) =>
    profile?.trim() ? profile.trim() : undefined,
  ),
}));

vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({ dispatch: mocks.dispatch })),
}));

vi.mock("../control-service.js", () => ({
  createBrowserControlContext: vi.fn(() => ({ control: true })),
  getBrowserControlState: vi.fn(() => null),
  startBrowserControlServiceFromConfig: mocks.startBrowserControlService,
}));

vi.mock("../browser/cdp.helpers.js", () => ({
  closeTrackedCdpTarget: mocks.closeTrackedCdpTarget,
  redactCdpUrl: vi.fn((url: string) => url),
}));

vi.mock("../browser/cdp-reachability-policy.js", () => ({
  resolveCdpControlPolicy: vi.fn(),
}));

vi.mock("../sdk-setup-tools.js", () => ({ detectMime: vi.fn(async () => "text/plain") }));

const { runBrowserProxyCommand } = await import("./invoke-browser.js");

const baseParams = {
  method: "POST",
  path: "/tabs/open",
  body: { url: "https://example.com" },
  profile: "openclaw",
  agentSessionKey: "agent:browser-session-credential-steward:node-run",
  agentId: "browser-session-credential-steward",
  nodeId: "node-1",
  pairingGeneration: "pairing-1",
  invocationId: "invoke-1",
} as const;

describe("node-host Browser Steward approval", () => {
  beforeEach(() => {
    mocks.closeTrackedCdpTarget.mockReset().mockResolvedValue({ status: "closed" });
    mocks.dispatch.mockReset();
    mocks.startBrowserControlService.mockClear().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a Browser Steward mutation when Gateway approval is absent", async () => {
    await expect(runBrowserProxyCommand(JSON.stringify(baseParams))).rejects.toThrow(
      /approval_required/,
    );
    expect(mocks.startBrowserControlService).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("redeems only an exact redacted Gateway approval", async () => {
    mocks.dispatch.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    const approval = createBrowserStewardGatewayApproval({
      command: "browser.proxy",
      ...baseParams,
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({ ...baseParams, browserStewardApproval: approval }),
        "browser.proxy",
        undefined,
        { nodeId: "node-1", pairingGeneration: "pairing-1", invocationId: "invoke-1" },
      ),
    ).resolves.toBe(JSON.stringify({ result: { ok: true } }));
    expect(mocks.startBrowserControlService).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(approval)).not.toContain("node-run");

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          ...baseParams,
          body: { url: "https://example.com/changed" },
          browserStewardApproval: approval,
        }),
        "browser.proxy",
        undefined,
        { nodeId: "node-1", pairingGeneration: "pairing-1", invocationId: "invoke-1" },
      ),
    ).rejects.toThrow(/approval_required/);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it("passes a live approval predicate to owned tab close", async () => {
    const ownership = {
      status: "durable",
      nativeTargetId: "NATIVE-7",
      profileFingerprint: "sha256:profile",
      browserInstanceFingerprint: "sha256:browser",
    } as const;
    const closeParams = {
      ...baseParams,
      path: BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
      body: { ownership },
      invocationId: "invoke-close-approval",
    } as const;
    const approval = createBrowserStewardGatewayApproval({
      command: "browser.proxy",
      ...closeParams,
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          ...closeParams,
          errorEnvelope: BROWSER_PROXY_ERROR_ENVELOPE,
          browserStewardApproval: approval,
        }),
        "browser.proxy",
        undefined,
        {
          nodeId: "node-1",
          pairingGeneration: "pairing-1",
          invocationId: "invoke-close-approval",
        },
      ),
    ).resolves.toBe(
      JSON.stringify({
        result: { status: "closed" },
        route: { status: "resolved", profile: "openclaw", driver: "openclaw" },
      }),
    );

    expect(mocks.closeTrackedCdpTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldClose: expect.any(Function),
      }),
    );
    const closeCall = mocks.closeTrackedCdpTarget.mock.calls[0]?.[0];
    expect(closeCall?.shouldClose?.()).toBe(true);
  });

  it("rejects replay on a different node or invocation and consumes once", async () => {
    const approval = createBrowserStewardGatewayApproval({
      command: "browser.proxy",
      ...baseParams,
      invocationId: "invoke-replay",
    });
    mocks.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({ ...baseParams, browserStewardApproval: approval }),
        "browser.proxy",
        undefined,
        { nodeId: "other-node", pairingGeneration: "pairing-1", invocationId: "invoke-replay" },
      ),
    ).rejects.toThrow(/approval_required/);
    await expect(
      runBrowserProxyCommand(
        JSON.stringify({ ...baseParams, browserStewardApproval: approval }),
        "browser.proxy",
        undefined,
        { nodeId: "node-1", pairingGeneration: "pairing-1", invocationId: "other-invocation" },
      ),
    ).rejects.toThrow(/approval_required/);
    await expect(
      runBrowserProxyCommand(
        JSON.stringify({ ...baseParams, browserStewardApproval: approval }),
        "browser.proxy",
        undefined,
        { nodeId: "node-1", pairingGeneration: "pairing-1", invocationId: "invoke-replay" },
      ),
    ).resolves.toBe(JSON.stringify({ result: { ok: true } }));
    await expect(
      runBrowserProxyCommand(
        JSON.stringify({ ...baseParams, browserStewardApproval: approval }),
        "browser.proxy",
        undefined,
        { nodeId: "node-1", pairingGeneration: "pairing-1", invocationId: "invoke-replay" },
      ),
    ).rejects.toThrow(/approval_required/);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it("rejects a node frame whose authenticated pairing generation differs", async () => {
    const approval = createBrowserStewardGatewayApproval({
      command: "browser.proxy",
      ...baseParams,
      invocationId: "invoke-generation",
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({ ...baseParams, browserStewardApproval: approval }),
        "browser.proxy",
        undefined,
        {
          nodeId: "node-1",
          pairingGeneration: "pairing-2",
          invocationId: "invoke-generation",
        },
      ),
    ).rejects.toThrow(/approval_required/);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not start the Browser service when approval is already expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(31_001);
    vi.resetModules();
    const [
      { createBrowserStewardGatewayApproval: createFreshApproval },
      { runBrowserProxyCommand: runFreshBrowserProxyCommand },
    ] = await Promise.all([
      import("../browser/browser-steward-approval.js"),
      import("./invoke-browser.js"),
    ]);
    const approval = createFreshApproval({
      command: "browser.proxy",
      ...baseParams,
      invocationId: "invoke-expired-before-startup",
      nowMs: 1_000,
    });

    await expect(
      runFreshBrowserProxyCommand(
        JSON.stringify({
          ...baseParams,
          invocationId: "invoke-expired-before-startup",
          browserStewardApproval: approval,
        }),
        "browser.proxy",
        undefined,
        {
          nodeId: "node-1",
          pairingGeneration: "pairing-1",
          invocationId: "invoke-expired-before-startup",
        },
      ),
    ).rejects.toThrow(/approval_required/);
    expect(mocks.startBrowserControlService).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects an approval that expires during startup before final browser I/O", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.resetModules();
    const [
      { createBrowserStewardGatewayApproval: createFreshApproval },
      { runBrowserProxyCommand: runFreshBrowserProxyCommand },
    ] = await Promise.all([
      import("../browser/browser-steward-approval.js"),
      import("./invoke-browser.js"),
    ]);
    let releaseStartup!: (value: boolean) => void;
    const startup = new Promise<boolean>((resolve) => {
      releaseStartup = resolve;
    });
    mocks.startBrowserControlService.mockReturnValueOnce(startup);
    mocks.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
    const approval = createFreshApproval({
      command: "browser.proxy",
      ...baseParams,
      invocationId: "invoke-expiring",
    });
    const trace = ["approved-before-startup"];
    const request = runFreshBrowserProxyCommand(
      JSON.stringify({
        ...baseParams,
        invocationId: "invoke-expiring",
        browserStewardApproval: approval,
      }),
      "browser.proxy",
      undefined,
      { nodeId: "node-1", pairingGeneration: "pairing-1", invocationId: "invoke-expiring" },
    );
    await Promise.resolve();
    expect(mocks.startBrowserControlService).toHaveBeenCalledOnce();
    vi.setSystemTime(31_001);
    releaseStartup(true);
    trace.push("revoked-before-final-browser-io");

    await expect(request).rejects.toThrow(/approval_required/);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(trace).toEqual(["approved-before-startup", "revoked-before-final-browser-io"]);
    expect(JSON.stringify(trace)).not.toContain("invoke-expiring");
  });

  it("preserves a completed browser result when the lease expires during dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let releaseDispatch!: (value: { status: number; body: { ok: boolean } }) => void;
    mocks.dispatch.mockReturnValueOnce(
      new Promise<{ status: number; body: { ok: boolean } }>((resolve) => {
        releaseDispatch = resolve;
      }),
    );
    const approval = createBrowserStewardGatewayApproval({
      command: "browser.proxy",
      ...baseParams,
      invocationId: "invoke-dispatch-expiry",
    });
    const request = runBrowserProxyCommand(
      JSON.stringify({
        ...baseParams,
        invocationId: "invoke-dispatch-expiry",
        browserStewardApproval: approval,
      }),
      "browser.proxy",
      undefined,
      { nodeId: "node-1", pairingGeneration: "pairing-1", invocationId: "invoke-dispatch-expiry" },
    );
    for (let attempt = 0; attempt < 10 && mocks.dispatch.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    vi.setSystemTime(31_001);
    releaseDispatch({ status: 200, body: { ok: true } });

    await expect(request).resolves.toBe(JSON.stringify({ result: { ok: true } }));
  });
});
