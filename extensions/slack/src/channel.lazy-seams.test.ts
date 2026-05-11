// Regression tests for the lazy-loading boundaries introduced for Slack
// startup-perf work (see PR #69317). Each test asserts both:
//   - that the lazy module is reached (call mocks fire), and
//   - that the inputs forwarded into the lazy module are correct, and
//   - that the lazy module's return value is propagated back through the
//     plugin surface unchanged.
//
// Together these guard against:
//   - dynamic-import path/specifier drift on cold paths,
//   - silent contract drift between the channel and its lazy modules,
//   - and accidental loss of the perf intent (re-introducing eager imports
//     without updating the seam).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { setSlackRuntime } from "./runtime.js";

// --- Hoisted mocks for lazy seams ------------------------------------------------

const collectAuditFindingsMock = vi.hoisted(() => vi.fn());
const fetchSlackScopesMock = vi.hoisted(() => vi.fn());
const resolveTargetsWithOptionalTokenMock = vi.hoisted(() => vi.fn());
const buildPassiveProbedChannelStatusSummaryMock = vi.hoisted(() => vi.fn());
vi.mock("./security-audit.js", () => ({
  collectSlackSecurityAuditFindings: collectAuditFindingsMock,
}));

vi.mock("./scopes.js", () => ({
  fetchSlackScopes: fetchSlackScopesMock,
}));

vi.mock("openclaw/plugin-sdk/target-resolver-runtime", async (orig) => {
  // Preserve any sibling exports so importers that touch unrelated helpers
  // do not break; only override the function the channel actually calls.
  const original = (await orig()) as Record<string, unknown>;
  return {
    ...original,
    resolveTargetsWithOptionalToken: resolveTargetsWithOptionalTokenMock,
  };
});

vi.mock("openclaw/plugin-sdk/extension-shared", async (orig) => {
  const original = (await orig()) as Record<string, unknown>;
  return {
    ...original,
    buildPassiveProbedChannelStatusSummary: buildPassiveProbedChannelStatusSummaryMock,
  };
});

// --- Test setup -----------------------------------------------------------------

beforeEach(() => {
  collectAuditFindingsMock.mockReset();
  fetchSlackScopesMock.mockReset();
  resolveTargetsWithOptionalTokenMock.mockReset();
  buildPassiveProbedChannelStatusSummaryMock.mockReset();
  setSlackRuntime({ channel: { slack: {} } } as never);
});

function makeMinimalSlackConfig(
  opts: { botToken?: string; userToken?: string } = {},
): OpenClawConfig {
  const slack: Record<string, unknown> = {};
  if (opts.botToken !== undefined) {
    slack.botToken = opts.botToken;
  }
  if (opts.userToken !== undefined) {
    slack.userToken = opts.userToken;
  }
  return { channels: { slack } } as OpenClawConfig;
}

// --- Status: buildChannelSummary -------------------------------------------------

describe("slackPlugin.status.buildChannelSummary lazy SDK forwarding", () => {
  it("calls the lazy extension-shared SDK helper with the snapshot and token sources, and returns its output unchanged", async () => {
    const buildChannelSummary = slackPlugin.status?.buildChannelSummary;
    if (!buildChannelSummary) {
      throw new Error("slackPlugin.status.buildChannelSummary should be exposed");
    }

    const sentinelSummary = { sentinel: "passive-summary" };
    buildPassiveProbedChannelStatusSummaryMock.mockReturnValue(sentinelSummary);

    const snapshot = {
      accountId: "default",
      configured: true,
      enabled: true,
      botTokenSource: "config" as const,
      appTokenSource: "config" as const,
      extra: { custom: 1 },
    };

    const result = await buildChannelSummary({
      account: { accountId: "default" } as never,
      snapshot,
      cfg: makeMinimalSlackConfig({ botToken: "xoxb-test" }),
      runtime: undefined,
    } as never);

    expect(buildPassiveProbedChannelStatusSummaryMock).toHaveBeenCalledTimes(1);
    const [forwardedSnapshot, forwardedExtras] =
      buildPassiveProbedChannelStatusSummaryMock.mock.calls[0] ?? [];
    // Snapshot must be forwarded by reference / structurally intact.
    expect(forwardedSnapshot).toBe(snapshot);
    // The channel must forward the (possibly fallback'd) token sources.
    expect(forwardedExtras).toEqual({ botTokenSource: "config", appTokenSource: "config" });
    // The SDK return value must be propagated through unchanged.
    expect(result).toBe(sentinelSummary);
  });

  it("falls back to 'none' for missing token sources before forwarding to the SDK helper", async () => {
    const buildChannelSummary = slackPlugin.status?.buildChannelSummary;
    if (!buildChannelSummary) {
      throw new Error("slackPlugin.status.buildChannelSummary should be exposed");
    }

    buildPassiveProbedChannelStatusSummaryMock.mockReturnValue({ sentinel: true });

    await buildChannelSummary({
      account: { accountId: "default" } as never,
      snapshot: { accountId: "default", configured: false, enabled: true } as never,
      cfg: makeMinimalSlackConfig(),
      runtime: undefined,
    } as never);

    const [, forwardedExtras] = buildPassiveProbedChannelStatusSummaryMock.mock.calls[0] ?? [];
    expect(forwardedExtras).toEqual({ botTokenSource: "none", appTokenSource: "none" });
  });
});

// --- Status: buildCapabilitiesDiagnostics ---------------------------------------

describe("slackPlugin.status.buildCapabilitiesDiagnostics lazy scopes loader", () => {
  it("invokes fetchSlackScopes once when only a bot token is present", async () => {
    const buildDiagnostics = slackPlugin.status?.buildCapabilitiesDiagnostics;
    if (!buildDiagnostics) {
      throw new Error("slackPlugin.status.buildCapabilitiesDiagnostics should be exposed");
    }

    fetchSlackScopesMock.mockResolvedValue({ ok: true, scopes: ["chat:write"] });

    const cfg = makeMinimalSlackConfig({ botToken: "xoxb-bot" });
    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const result = await buildDiagnostics({ account, timeoutMs: 1234, cfg } as never);

    expect(fetchSlackScopesMock).toHaveBeenCalledTimes(1);
    expect(fetchSlackScopesMock).toHaveBeenCalledWith("xoxb-bot", 1234);
    expect(result?.details).toEqual({ botScopes: { ok: true, scopes: ["chat:write"] } });
    expect(result?.lines?.length ?? 0).toBeGreaterThan(0);
  });

  it("invokes fetchSlackScopes twice (bot and user) when both tokens are present", async () => {
    const buildDiagnostics = slackPlugin.status?.buildCapabilitiesDiagnostics;
    if (!buildDiagnostics) {
      throw new Error("slackPlugin.status.buildCapabilitiesDiagnostics should be exposed");
    }

    fetchSlackScopesMock
      .mockResolvedValueOnce({ ok: true, scopes: ["chat:write"] })
      .mockResolvedValueOnce({ ok: true, scopes: ["users:read"] });

    const cfg = makeMinimalSlackConfig({ botToken: "xoxb-bot", userToken: "xoxp-user" });
    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const result = await buildDiagnostics({ account, timeoutMs: 5000, cfg } as never);

    expect(fetchSlackScopesMock).toHaveBeenCalledTimes(2);
    expect(fetchSlackScopesMock.mock.calls[0]).toEqual(["xoxb-bot", 5000]);
    expect(fetchSlackScopesMock.mock.calls[1]).toEqual(["xoxp-user", 5000]);
    expect(result?.details).toEqual({
      botScopes: { ok: true, scopes: ["chat:write"] },
      userScopes: { ok: true, scopes: ["users:read"] },
    });
  });

  it("does not invoke fetchSlackScopes when no bot token is present and reports a missing-token diagnostic", async () => {
    const buildDiagnostics = slackPlugin.status?.buildCapabilitiesDiagnostics;
    if (!buildDiagnostics) {
      throw new Error("slackPlugin.status.buildCapabilitiesDiagnostics should be exposed");
    }

    const cfg = makeMinimalSlackConfig();
    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const result = await buildDiagnostics({ account, timeoutMs: 1000, cfg } as never);

    expect(fetchSlackScopesMock).not.toHaveBeenCalled();
    expect(result?.details).toEqual({
      botScopes: { ok: false, error: "Slack bot token missing." },
    });
  });
});

// --- Security: collectAuditFindings ---------------------------------------------

describe("slackPlugin.security.collectAuditFindings lazy module forwarding", () => {
  it("delegates to the lazy security-audit module with the original params and returns its output", async () => {
    const collectAuditFindings = slackPlugin.security?.collectAuditFindings;
    if (!collectAuditFindings) {
      throw new Error("slackPlugin.security.collectAuditFindings should be exposed");
    }

    const sentinel = [
      {
        checkId: "test-check",
        severity: "info" as const,
        title: "t",
        detail: "d",
      },
    ];
    collectAuditFindingsMock.mockResolvedValue(sentinel);

    const cfg = makeMinimalSlackConfig({ botToken: "xoxb-bot" });
    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const result = await collectAuditFindings({ cfg, accountId: "default", account } as never);

    expect(collectAuditFindingsMock).toHaveBeenCalledTimes(1);
    expect(collectAuditFindingsMock.mock.calls[0]?.[0]).toEqual({
      cfg,
      accountId: "default",
      account,
    });
    expect(result).toBe(sentinel);
  });

  it("propagates an empty findings array unchanged", async () => {
    const collectAuditFindings = slackPlugin.security?.collectAuditFindings;
    if (!collectAuditFindings) {
      throw new Error("slackPlugin.security.collectAuditFindings should be exposed");
    }

    collectAuditFindingsMock.mockResolvedValue([]);

    const cfg = makeMinimalSlackConfig();
    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const result = await collectAuditFindings({ cfg, account } as never);

    expect(result).toStrictEqual([]);
  });
});

// --- Resolver: resolveTargets ---------------------------------------------------

describe("slackPlugin.resolver.resolveTargets lazy SDK forwarding", () => {
  it("forwards user inputs and the configured token to the lazy SDK helper and returns its output", async () => {
    const resolveTargets = slackPlugin.resolver?.resolveTargets;
    if (!resolveTargets) {
      throw new Error("slackPlugin.resolver.resolveTargets should be exposed");
    }

    const sentinelOutput = [{ input: "U123", resolved: true, id: "U123", note: undefined }];
    resolveTargetsWithOptionalTokenMock.mockResolvedValue(sentinelOutput);

    const cfg = makeMinimalSlackConfig({ botToken: "xoxb-bot" });
    const result = await resolveTargets({
      cfg,
      accountId: "default",
      inputs: ["U123"],
      kind: "user",
    } as never);

    expect(resolveTargetsWithOptionalTokenMock).toHaveBeenCalledTimes(1);
    const [params] = resolveTargetsWithOptionalTokenMock.mock.calls[0] ?? [];
    expect(params.token).toBe("xoxb-bot");
    expect(params.inputs).toEqual(["U123"]);
    expect(params.missingTokenNote).toBe("missing Slack token");
    if (typeof params.resolveWithToken !== "function") {
      throw new Error("expected Slack target resolver callback");
    }
    if (typeof params.mapResolved !== "function") {
      throw new Error("expected Slack target mapper callback");
    }
    expect(
      params.mapResolved({
        input: "U123",
        resolved: true,
        id: "U123",
        name: "Ada",
        note: "workspace match",
      }),
    ).toEqual({
      input: "U123",
      resolved: true,
      id: "U123",
      name: "Ada",
      note: "workspace match",
    });
    expect(result).toBe(sentinelOutput);
  });

  it("prefers the user token over the bot token when both are configured", async () => {
    const resolveTargets = slackPlugin.resolver?.resolveTargets;
    if (!resolveTargets) {
      throw new Error("slackPlugin.resolver.resolveTargets should be exposed");
    }

    resolveTargetsWithOptionalTokenMock.mockResolvedValue([]);

    await resolveTargets({
      cfg: makeMinimalSlackConfig({ botToken: "xoxb-bot", userToken: "xoxp-user" }),
      accountId: "default",
      inputs: ["U1"],
      kind: "user",
    } as never);

    const [params] = resolveTargetsWithOptionalTokenMock.mock.calls[0] ?? [];
    expect(params.token).toBe("xoxp-user");
  });

  it("uses the same lazy SDK helper for kind='group'", async () => {
    const resolveTargets = slackPlugin.resolver?.resolveTargets;
    if (!resolveTargets) {
      throw new Error("slackPlugin.resolver.resolveTargets should be exposed");
    }

    resolveTargetsWithOptionalTokenMock.mockResolvedValue([]);

    await resolveTargets({
      cfg: makeMinimalSlackConfig({ botToken: "xoxb-bot" }),
      accountId: "default",
      inputs: ["C1"],
      kind: "group",
    } as never);

    expect(resolveTargetsWithOptionalTokenMock).toHaveBeenCalledTimes(1);
    const [params] = resolveTargetsWithOptionalTokenMock.mock.calls[0] ?? [];
    expect(params.token).toBe("xoxb-bot");
    expect(params.inputs).toEqual(["C1"]);
  });
});

// Setup-wizard proxy delegation is unit-tested directly in
// setup-core.lazy-proxy.test.ts so it can be type-safe against the wider
// ChannelSetupWizard contract returned by createSlackSetupWizardProxy.
