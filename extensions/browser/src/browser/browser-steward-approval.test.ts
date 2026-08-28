import { describe, expect, it, vi } from "vitest";

describe("Browser Steward runtime approval", () => {
  const hostBinding = { backend: { kind: "host" as const } };

  function approvePreparedRuntimeParams(
    module: typeof import("./browser-steward-approval.js"),
    rawParams: Record<string, unknown>,
    binding: import("./browser-steward-approval.js").BrowserStewardRuntimeApprovalBinding,
    authority?: import("./browser-steward-approval.js").BrowserStewardRuntimeApprovalAuthority,
  ): Record<string, unknown> {
    const prepared = module.prepareBrowserStewardRuntimeParams(
      rawParams,
      binding,
      authority,
    ) as Record<string, unknown>;
    module.approveBrowserStewardRuntimeParams(prepared, authority);
    return prepared;
  }

  it("requires the Browser-owned authority across separate plugin module instances", async () => {
    const firstModule = await import("./browser-steward-approval.js");
    const authority = firstModule.createBrowserStewardRuntimeApprovalAuthority();
    const rawParams = {
      action: "act",
      request: { kind: "type", text: "synthetic-secret" },
    };
    const approvedParams = approvePreparedRuntimeParams(
      firstModule,
      rawParams,
      hostBinding,
      authority,
    );

    vi.resetModules();
    const secondModule = await import("./browser-steward-approval.js");

    expect(secondModule.isBrowserStewardRuntimeApproved(approvedParams)).toBe(false);
    expect(secondModule.isBrowserStewardRuntimeApproved(approvedParams, authority)).toBe(true);
    expect(
      secondModule.resolveBrowserStewardRuntimeApprovedParams(approvedParams, authority),
    ).toEqual(rawParams);
    const serializedParams = JSON.stringify(approvedParams);
    expect(JSON.parse(serializedParams)).toEqual({
      action: "act",
      request: { kind: "type", text: "REDACTED" },
    });
    expect(secondModule.isBrowserStewardRuntimeApproved({ approved: true })).toBe(false);
  });

  it("does not expose approval state through global symbols or forgeable marker fields", async () => {
    const module = await import("./browser-steward-approval.js");
    const rawParams = { action: "act", request: { kind: "type", text: "synthetic-secret" } };
    const pendingParams = module.prepareBrowserStewardRuntimeParams(
      rawParams,
      hostBinding,
    ) as Record<string, unknown>;
    const globalSymbols = Object.getOwnPropertySymbols(globalThis);

    expect(
      globalSymbols.some((symbol) =>
        (symbol.description ?? "").includes("browser-steward-runtime-approval"),
      ),
    ).toBe(false);
    expect(module.isBrowserStewardRuntimeApproved(pendingParams)).toBe(false);

    const forgedParams = { ...pendingParams };
    for (const symbol of Object.getOwnPropertySymbols(pendingParams)) {
      Object.defineProperty(forgedParams, symbol, {
        value: Reflect.get(pendingParams, symbol),
        enumerable: true,
      });
    }
    expect(module.isBrowserStewardRuntimeApproved(forgedParams)).toBe(false);
  });

  it("invalidates approval when downstream code rewrites the approved operation", async () => {
    const module = await import("./browser-steward-approval.js");
    const rawParams = {
      action: "act",
      request: { kind: "type", text: "synthetic-secret" },
    };
    const approvedParams = approvePreparedRuntimeParams(module, rawParams, hostBinding);
    const rewrittenRequest = { kind: "type", text: "policy-replacement" };

    const rewritten = {
      ...approvedParams,
      request: rewrittenRequest,
    };
    const resolved = module.resolveBrowserStewardRuntimeApprovedParams(rewritten);

    expect(module.isBrowserStewardRuntimeApproved(rewritten)).toBe(false);
    expect(resolved).toEqual(rewritten);
    expect(JSON.stringify(resolved)).not.toContain("synthetic-secret");
  });

  it("invalidates approval when downstream code mutates nested public parameters", async () => {
    const module = await import("./browser-steward-approval.js");
    const rawParams = {
      action: "act",
      request: { kind: "type", text: "synthetic-secret" },
    };
    const approvedParams = approvePreparedRuntimeParams(module, rawParams, hostBinding);
    const request = approvedParams.request as Record<string, unknown>;
    request.kind = "evaluate";

    expect(module.isBrowserStewardRuntimeApproved(approvedParams)).toBe(false);
    expect(module.resolveBrowserStewardRuntimeApprovedParams(approvedParams)).toBe(approvedParams);
    expect(JSON.stringify(approvedParams)).not.toContain("synthetic-secret");
  });

  it("restores an immutable snapshot of raw parameters after approval", async () => {
    const module = await import("./browser-steward-approval.js");
    const rawParams = {
      action: "act",
      request: { kind: "type", text: "original-secret" },
    };
    const approvedParams = approvePreparedRuntimeParams(module, rawParams, hostBinding);
    rawParams.request.text = "mutated-after-approval";

    const firstResolved = module.resolveBrowserStewardRuntimeApprovedParams(approvedParams);
    expect(firstResolved).toEqual({
      action: "act",
      request: { kind: "type", text: "original-secret" },
    });
    expect(module.isBrowserStewardRuntimeApproved(approvedParams)).toBe(false);
    expect(module.resolveBrowserStewardRuntimeApprovedParams(approvedParams)).toBe(approvedParams);
  });

  it("consumes allow-once approval during final execution resolution", async () => {
    const module = await import("./browser-steward-approval.js");
    const rawParams = { action: "act", request: { kind: "type", text: "one-shot-secret" } };
    const prepared = approvePreparedRuntimeParams(module, rawParams, hostBinding);
    const finalized = module.finalizeBrowserStewardRuntimeParams(
      structuredClone(prepared),
      prepared,
    ) as Record<string, unknown>;

    expect(module.isBrowserStewardRuntimeApproved(prepared)).toBe(false);
    expect(module.isBrowserStewardRuntimeApproved(finalized)).toBe(true);
    expect(module.resolveBrowserStewardRuntimeApprovedParams(finalized)).toEqual(rawParams);
    expect(module.isBrowserStewardRuntimeApproved(finalized)).toBe(false);
    expect(module.resolveBrowserStewardRuntimeApprovedParams(finalized)).toBe(finalized);
    const reused = module.finalizeBrowserStewardRuntimeParams(structuredClone(prepared), prepared);
    expect(module.isBrowserStewardRuntimeApproved(reused)).toBe(false);
    expect(reused).toEqual(structuredClone(prepared));
  });

  it("keeps pending params redacted until the Browser approval itself resolves", async () => {
    const module = await import("./browser-steward-approval.js");
    const rawParams = { action: "act", password: "synthetic-secret" };
    const pendingParams = module.prepareBrowserStewardRuntimeParams(
      rawParams,
      hostBinding,
    ) as Record<string, unknown>;

    expect(module.isBrowserStewardRuntimeApproved(pendingParams)).toBe(false);
    for (const symbol of Object.getOwnPropertySymbols(pendingParams)) {
      expect(JSON.stringify(Reflect.get(pendingParams, symbol))).not.toContain("synthetic-secret");
    }
    expect(
      structuredClone(module.resolveBrowserStewardRuntimeApprovedParams(pendingParams)),
    ).toEqual({
      action: "act",
      password: "REDACTED",
    });

    module.approveBrowserStewardRuntimeParams(pendingParams);

    expect(module.isBrowserStewardRuntimeApproved(pendingParams)).toBe(true);
    expect(module.resolveBrowserStewardRuntimeApprovedParams(pendingParams)).toEqual(rawParams);
  });

  it("redacts prepared credential material while retaining it only for trusted policy resolution", async () => {
    const module = await import("./browser-steward-approval.js");
    const rawParams = {
      action: "upload",
      paths: ["/tmp/private-key.pem"],
      request: { kind: "type", text: "prepared-secret" },
      authorization: "Bearer prepared-token",
    };
    const prepared = module.prepareBrowserStewardRuntimeParams(rawParams) as Record<
      string,
      unknown
    >;

    expect(JSON.stringify(prepared)).not.toContain("prepared-secret");
    expect(JSON.stringify(prepared)).not.toContain("prepared-token");
    expect(JSON.stringify(prepared)).not.toContain("private-key.pem");
    expect(module.resolveBrowserStewardRuntimePolicyParams(prepared)).toEqual(rawParams);
    expect(module.resolveBrowserStewardRuntimeApprovedParams(prepared)).toEqual(prepared);
  });

  it("creates a redacted approval envelope bound to the exact browser request", async () => {
    const module = await import("./browser-steward-approval.js");
    const request = {
      command: "browser.proxy",
      method: "POST",
      path: "/act",
      body: { kind: "type", text: "raw-browser-secret" },
      profile: "openclaw",
      agentSessionKey: "agent:browser-session-credential-steward:direct:user-123",
      agentId: "browser-session-credential-steward",
      nodeId: "node-1",
      pairingGeneration: "pairing-1",
      invocationId: "invoke-1",
    } as const;
    const approval = module.createBrowserStewardGatewayApproval(request);

    expect(approval).toMatchObject({
      issuer: "gateway.operator.admin",
      command: "browser.proxy",
      action: "act",
      profile: "openclaw",
      sessionBoundary: {
        kind: "browser_steward",
        ownerAgentId: "browser-session-credential-steward",
        affectedSession: "agent:browser-session-credential-steward:REDACTED",
      },
      nodeId: "node-1",
      pairingGeneration: "pairing-1",
      invocationId: "invoke-1",
    });
    const serialized = JSON.stringify(approval);
    expect(serialized).not.toContain("raw-browser-secret");
    expect(serialized).not.toContain("user-123");
    expect(
      module.consumeBrowserStewardGatewayApprovalAuthority({ approval, ...request }),
    ).toBeDefined();
    expect(
      module.consumeBrowserStewardGatewayApprovalAuthority({
        approval,
        ...request,
        pairingGeneration: "different-pairing",
      }),
    ).toBeUndefined();
    expect(
      module.consumeBrowserStewardGatewayApprovalAuthority({
        approval,
        ...request,
        nowMs: approval.expiresAtMs,
      }),
    ).toBeUndefined();
    expect(
      module.consumeBrowserStewardGatewayApprovalAuthority({
        approval,
        ...request,
        body: { kind: "type", text: "different-secret" },
      }),
    ).toBeUndefined();
    expect(
      module.consumeBrowserStewardGatewayApprovalAuthority({
        approval: { ...approval, action: "navigate" },
        ...request,
      }),
    ).toBeUndefined();
  });

  it("canonicalizes trailing-slash proxy routes before approval fingerprinting", async () => {
    const module = await import("./browser-steward-approval.js");
    const request = {
      command: "browser.proxy",
      method: "POST",
      path: "/tabs/open/",
      body: { url: "https://example.com" },
      profile: "openclaw",
      agentSessionKey: "agent:browser-session-credential-steward:direct:opaque",
      agentId: "browser-session-credential-steward",
      nodeId: "node-1",
      pairingGeneration: "pairing-1",
      invocationId: "invoke-2",
    } as const;
    const approval = module.createBrowserStewardGatewayApproval(request);

    expect(approval.action).toBe("open");
    expect(
      module.consumeBrowserStewardGatewayApprovalAuthority({ approval, ...request }),
    ).toBeDefined();
    const normalizedApproval = module.createBrowserStewardGatewayApproval({
      ...request,
      path: "/tabs/open",
    });
    expect(
      module.consumeBrowserStewardGatewayApprovalAuthority({
        approval: normalizedApproval,
        ...request,
        path: "/tabs/open",
      }),
    ).toBeDefined();
  });

  it("binds private Gateway operation proofs to one request and one use", async () => {
    const module = await import("./browser-steward-approval.js");
    const request = {
      command: "browser.proxy",
      method: "POST",
      path: "/tabs/open",
      body: { url: "https://example.com" },
      profile: "openclaw",
      agentSessionKey: "agent:browser-session-credential-steward:direct:opaque",
      agentId: "browser-session-credential-steward",
      nodeId: "node-1",
      browserNodeSessionLease: "lease-1",
      allowAutomaticHostFallback: false,
    } as const;
    const claim = module.createBrowserStewardGatewayApprovalClaim(request);

    expect(JSON.stringify(claim)).not.toContain("opaque");
    expect(
      module.consumeBrowserStewardGatewayApprovalClaimAuthority({ approval: claim, ...request }),
    ).toBeDefined();
    expect(
      module.consumeBrowserStewardGatewayApprovalClaimAuthority({ approval: claim, ...request }),
    ).toBeUndefined();

    const expiredClaim = module.createBrowserStewardGatewayApprovalClaim({
      ...request,
      nowMs: 10_000,
    });
    expect(
      module.consumeBrowserStewardGatewayApprovalClaimAuthority({
        approval: expiredClaim,
        ...request,
        nowMs: expiredClaim.expiresAtMs,
      }),
    ).toBeUndefined();
  });
});
