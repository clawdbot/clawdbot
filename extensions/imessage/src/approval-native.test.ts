import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
// Imessage tests cover approval native plugin behavior.
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  imessageApprovalCapability,
  shouldSuppressLocalIMessageExecApprovalPrompt,
} from "./approval-native.js";

type IMessageConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]>;

const DEFAULT_ACCOUNT_ID = "default";
const DIRECT_TARGET = "+15551230000";
const GROUP_TARGET = "chat_guid:iMessage;+;chat42";

function buildConfig(
  params: {
    imessage?: Partial<IMessageConfig>;
    approvals?: OpenClawConfig["approvals"];
  } = {},
): OpenClawConfig {
  return {
    channels: {
      imessage: {
        enabled: true,
        ...params.imessage,
      },
    },
    approvals: params.approvals,
  } as OpenClawConfig;
}

function buildTargetModeConfig(
  approvalKind: ChannelApprovalKind,
  targets: Array<{ channel: string; to: string; accountId?: string }>,
  params: { mode?: "targets" | "both"; imessage?: Partial<IMessageConfig> } = {},
) {
  return buildConfig({
    imessage: params.imessage,
    approvals: {
      [approvalKind]: {
        enabled: true,
        mode: params.mode ?? "targets",
        targets,
      },
    } as never,
  });
}

function buildExecRequest(
  turnSourceTo: string,
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return {
    id: "exec-1",
    request: {
      command: "echo hi",
      agentId: "main",
      turnSourceChannel: "imessage",
      turnSourceTo,
      turnSourceAccountId: "default",
      sessionKey: `agent:main:imessage:${turnSourceTo}`,
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

function buildPluginRequest(
  turnSourceTo: string,
  overrides: Partial<PluginApprovalRequest["request"]> = {},
): PluginApprovalRequest {
  return {
    id: "plugin:approval-1",
    request: {
      title: "Plugin approval",
      description: "Allow plugin action",
      agentId: "main",
      turnSourceChannel: "imessage",
      turnSourceTo,
      turnSourceAccountId: "default",
      sessionKey: `agent:main:imessage:${turnSourceTo}`,
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

function nativeShouldHandle(params: {
  cfg: OpenClawConfig;
  approvalKind: ChannelApprovalKind;
  request: ExecApprovalRequest | PluginApprovalRequest;
  accountId?: string | null;
}) {
  return imessageApprovalCapability.nativeRuntime?.availability.shouldHandle({
    cfg: params.cfg,
    accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
    context: {},
    approvalKind: params.approvalKind,
    request: params.request,
  });
}

function getAvailability(
  cfg: OpenClawConfig,
  accountId = DEFAULT_ACCOUNT_ID,
  approvalKind: ChannelApprovalKind = "exec",
) {
  return imessageApprovalCapability.getActionAvailabilityState?.({
    cfg,
    accountId,
    action: "approve",
    approvalKind,
  });
}

function describeDelivery(
  cfg: OpenClawConfig,
  request: ExecApprovalRequest | PluginApprovalRequest,
  approvalKind: ChannelApprovalKind = "exec",
) {
  return imessageApprovalCapability.native?.describeDeliveryCapabilities({
    cfg,
    accountId: DEFAULT_ACCOUNT_ID,
    approvalKind,
    request,
  });
}

function resolveExecOrigin(cfg: OpenClawConfig, request: ExecApprovalRequest) {
  return imessageApprovalCapability.native?.resolveOriginTarget?.({
    cfg,
    accountId: DEFAULT_ACCOUNT_ID,
    approvalKind: "exec",
    request,
  });
}

type ForwardingSuppressionParams = Parameters<
  NonNullable<
    NonNullable<typeof imessageApprovalCapability.delivery>["shouldSuppressForwardingFallback"]
  >
>[0];

function suppressForwardingFallback(params: ForwardingSuppressionParams) {
  return imessageApprovalCapability.delivery?.shouldSuppressForwardingFallback?.(params);
}

function suppressTargetForwarding(
  cfg: OpenClawConfig,
  to: string,
  request = buildExecRequest(DIRECT_TARGET),
) {
  return suppressForwardingFallback({
    cfg,
    approvalKind: "exec",
    target: { channel: "imessage", to, source: "target" },
    request,
  });
}

function buildLocalApprovalPayload(
  params: {
    approvalKind?: ChannelApprovalKind;
    agentId?: string | null;
    sessionKey?: string | null;
  } = {},
) {
  return {
    text: "Approval required.",
    channelData: {
      execApproval: {
        approvalId: params.approvalKind === "plugin" ? "plugin:approval-1" : "exec-1",
        approvalSlug: params.approvalKind === "plugin" ? "plugin:approval-1" : "exec-1",
        approvalKind: params.approvalKind ?? "exec",
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      },
    },
  };
}

const ACTIVE_EXEC_HINT = {
  kind: "approval-pending",
  approvalKind: "exec",
  nativeRouteActive: true,
} as const;

type LocalSuppressionParams = Parameters<typeof shouldSuppressLocalIMessageExecApprovalPrompt>[0];

function suppressLocalPrompt(
  params: Omit<LocalSuppressionParams, "hint"> & {
    hint?: LocalSuppressionParams["hint"];
  },
) {
  return shouldSuppressLocalIMessageExecApprovalPrompt({
    ...params,
    hint: params.hint ?? ACTIVE_EXEC_HINT,
  });
}

function suppressLocalSessionPrompt(
  cfg: OpenClawConfig,
  sessionKey: string,
  params: { accountId?: string; agentId?: string | null } = {},
) {
  return suppressLocalPrompt({
    cfg,
    accountId: params.accountId,
    payload: buildLocalApprovalPayload({
      agentId: params.agentId === undefined ? "main" : params.agentId,
      sessionKey,
    }),
  });
}

describe("imessage approval capability", () => {
  it("subscribes the native runtime to system-agent approval events", () => {
    expect(imessageApprovalCapability.nativeRuntime?.eventKinds).toContain("system-agent");
  });

  it("disables native approvals when no top-level approvals config is set", () => {
    const cfg = buildConfig();
    const execRequest = buildExecRequest(DIRECT_TARGET);
    const pluginRequest = buildPluginRequest(DIRECT_TARGET);

    expect(getAvailability(cfg)).toEqual({ kind: "disabled" });
    expect(describeDelivery(cfg, execRequest)?.enabled).toBe(false);
    expect(nativeShouldHandle({ cfg, approvalKind: "exec", request: execRequest })).toBe(false);
    expect(nativeShouldHandle({ cfg, approvalKind: "plugin", request: pluginRequest })).toBe(false);
  });

  it("allows session-mode exec delivery for matching iMessage origins", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest(DIRECT_TARGET);

    expect(describeDelivery(cfg, request)).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: false,
      notifyOriginWhenDmOnly: true,
    });
    expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(true);
  });

  it("keeps exec and plugin forwarding gates independent", () => {
    const execOnly = buildConfig({ approvals: { exec: { enabled: true } } });
    const pluginOnly = buildConfig({ approvals: { plugin: { enabled: true } } });

    expect(
      nativeShouldHandle({
        cfg: execOnly,
        approvalKind: "plugin",
        request: buildPluginRequest(DIRECT_TARGET),
      }),
    ).toBe(false);
    expect(
      nativeShouldHandle({
        cfg: pluginOnly,
        approvalKind: "exec",
        request: buildExecRequest(DIRECT_TARGET),
      }),
    ).toBe(false);
    expect(
      nativeShouldHandle({
        cfg: pluginOnly,
        approvalKind: "plugin",
        request: buildPluginRequest(DIRECT_TARGET),
      }),
    ).toBe(true);
  });

  it("does not use session mode for non-iMessage-origin requests", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("", {
      turnSourceChannel: "slack",
      turnSourceTo: "C123",
      sessionKey: "agent:main:slack:channel:c123",
    });

    expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(false);
    expect(describeDelivery(cfg, request)?.enabled).toBe(false);
  });

  it("rejects group origin targets when no approvers are configured", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest(GROUP_TARGET);

    expect(resolveExecOrigin(cfg, request)).toBeNull();
  });

  it("allows group origin targets when explicit approvers are configured", () => {
    const cfg = buildConfig({
      imessage: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });
    const request = buildExecRequest(GROUP_TARGET);

    expect(resolveExecOrigin(cfg, request)).toEqual({
      to: GROUP_TARGET,
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });

  it("resolves approver-dm targets from channels.imessage.allowFrom when the request is session-eligible", () => {
    const cfg = buildConfig({
      imessage: { allowFrom: ["+15551230000", "owner@example.com"] },
      approvals: { exec: { enabled: true } },
    });
    const request = buildExecRequest("+15551239999");

    const targets = imessageApprovalCapability.native?.resolveApproverDmTargets?.({
      cfg,
      accountId: "default",
      approvalKind: "exec",
      request,
    });

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "+15551230000" }),
        expect.objectContaining({ to: "owner@example.com" }),
      ]),
    );
  });

  it("uses target-mode config for requestless availability without native runtime handling", () => {
    const cfg = buildTargetModeConfig("exec", [{ channel: "imessage", to: DIRECT_TARGET }]);
    const request = buildExecRequest(DIRECT_TARGET);

    expect(getAvailability(cfg)).toEqual({ kind: "enabled" });
    expect(
      imessageApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
        context: {},
      }),
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(false);
  });

  it("disables delivery when the iMessage channel is disabled", () => {
    const cfg = buildConfig({
      imessage: { enabled: false },
      approvals: { exec: { enabled: true } },
    });
    const request = buildExecRequest(DIRECT_TARGET);

    expect(describeDelivery(cfg, request)?.enabled).toBe(false);
    expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(false);
  });

  it("renders thumbs-only reaction hints in exec approval prompts", () => {
    const payload = imessageApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg: buildConfig(),
      request: buildExecRequest(DIRECT_TARGET),
      target: { channel: "imessage", to: DIRECT_TARGET, source: "target" },
      nowMs: 0,
    });

    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
  });

  it("renders thumbs-only reaction hints in plugin approval prompts and respects allowed decisions", () => {
    const payload = imessageApprovalCapability.render?.plugin?.buildPendingPayload?.({
      cfg: buildConfig(),
      request: buildPluginRequest(DIRECT_TARGET, {
        allowedDecisions: ["allow-once", "deny"],
      }) as never,
      target: { channel: "imessage", to: DIRECT_TARGET, source: "target" },
      nowMs: 0,
    });

    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
    expect(payload?.text).not.toContain("Allow Always");
  });

  it("renders target-mode exec prompts with concrete thumbs-only reaction choices", () => {
    const cfg = buildTargetModeConfig("exec", [{ channel: "imessage", to: DIRECT_TARGET }]);
    const request = buildExecRequest(DIRECT_TARGET, {
      ask: "always",
      cwd: "/tmp/work",
      host: "gateway",
    });

    const payload = imessageApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "imessage", to: DIRECT_TARGET, source: "target" },
      nowMs: 0,
    });
    const text = payload?.text ?? "";

    expect(text).toContain("/approve exec-1 allow-once");
    expect(text).toContain("React with:");
    expect(text).toContain("👍 Allow Once");
    expect(text).toContain("👎 Deny");
    expect(text).not.toContain("<id>");
    expect(text).not.toContain("1️⃣ Allow Once");
    expect(text).not.toContain("2️⃣ Allow Always");
    expect(text).not.toContain("3️⃣ Deny");
    expect(text.indexOf("React with:")).toBeLessThan(text.indexOf("/approve exec-1 allow-once"));
  });

  it("renders target-mode plugin prompts with concrete thumbs-only reaction choices", () => {
    const cfg = buildTargetModeConfig("plugin", [{ channel: "imessage", to: DIRECT_TARGET }]);
    const request = buildPluginRequest(DIRECT_TARGET, {
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const payload = imessageApprovalCapability.render?.plugin?.buildPendingPayload?.({
      cfg,
      request: request as never,
      target: { channel: "imessage", to: DIRECT_TARGET, source: "target" },
      nowMs: 0,
    });

    expect(payload?.text).toContain("/approve plugin:approval-1 allow-once");
    expect(payload?.text).toContain(
      "Reply with: /approve plugin:approval-1 allow-once|allow-always|deny",
    );
    expect(payload?.text).toContain("React with:");
    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
    expect(payload?.text).not.toContain("1️⃣ Allow Once");
    expect(payload?.text).not.toContain("2️⃣ Allow Always");
    expect(payload?.text).not.toContain("3️⃣ Deny");
    expect(payload?.text).not.toContain("<id>");
  });

  it("does not report target-mode availability when no iMessage target matches", () => {
    const cfg = buildTargetModeConfig("exec", [{ channel: "slack", to: "C123" }]);

    expect(getAvailability(cfg)).toEqual({ kind: "disabled" });
  });

  it("applies agent and session filters to native handling", () => {
    const request = buildExecRequest(DIRECT_TARGET, {
      agentId: "main",
      sessionKey: "agent:main:imessage:+15551230000",
    });
    const blockedByAgent = buildConfig({
      approvals: { exec: { enabled: true, agentFilter: ["other"] } },
    });
    const blockedBySession = buildConfig({
      approvals: { exec: { enabled: true, sessionFilter: ["telegram"] } },
    });

    expect(nativeShouldHandle({ cfg: blockedByAgent, approvalKind: "exec", request })).toBe(false);
    expect(nativeShouldHandle({ cfg: blockedBySession, approvalKind: "exec", request })).toBe(
      false,
    );
  });

  it("matches account-scoped top-level iMessage targets only for that account", () => {
    const cfg = buildTargetModeConfig(
      "exec",
      [{ channel: "imessage", to: DIRECT_TARGET, accountId: "work" }],
      {
        imessage: {
          accounts: {
            work: { enabled: true },
          },
        } as Partial<IMessageConfig>,
      },
    );

    expect(getAvailability(cfg)).toEqual({ kind: "disabled" });
    expect(getAvailability(cfg, "work")).toEqual({ kind: "enabled" });
  });

  it("suppresses forwarding fallback only when the exact session-origin native target matches", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest(DIRECT_TARGET);

    expect(
      suppressForwardingFallback({
        cfg,
        approvalKind: "exec",
        target: {
          channel: "imessage",
          to: DIRECT_TARGET,
          accountId: DEFAULT_ACCOUNT_ID,
          source: "session",
        },
        request,
      }),
    ).toBe(true);
    expect(
      suppressForwardingFallback({
        cfg,
        approvalKind: "exec",
        target: {
          channel: "imessage",
          to: "+15550000000",
          accountId: "default",
          source: "session",
        },
        request,
      }),
    ).toBe(false);
  });

  it("does not suppress target-only forwarding when native delivery cannot bind that target", () => {
    // Locks down the behavior the live Lobster deploy exercised: with
    // mode=targets and no matching iMessage session-origin, the suppression
    // gate must stay off so the legacy forwarding path can deliver the
    // prompt. Regressing this would leave targets-only operators with no
    // delivery path (native runtime requires session-mode availability).
    const cfg = buildTargetModeConfig("exec", [{ channel: "imessage", to: "+15550000000" }]);

    expect(suppressTargetForwarding(cfg, "+15550000000")).toBe(false);
  });

  it("suppresses both-mode explicit targets that omit the origin account id", () => {
    const cfg = buildTargetModeConfig("exec", [{ channel: "imessage", to: DIRECT_TARGET }], {
      mode: "both",
    });

    expect(suppressTargetForwarding(cfg, DIRECT_TARGET)).toBe(true);
  });

  it("suppresses both-mode unscoped targets through the configured default iMessage account", () => {
    const cfg = buildTargetModeConfig("exec", [{ channel: "imessage", to: DIRECT_TARGET }], {
      mode: "both",
      imessage: {
        defaultAccount: "work",
        accounts: {
          default: { enabled: true },
          work: { enabled: true },
        },
      } as Partial<IMessageConfig>,
    });

    expect(
      suppressTargetForwarding(
        cfg,
        DIRECT_TARGET,
        buildExecRequest(DIRECT_TARGET, {
          turnSourceAccountId: "work",
        }),
      ),
    ).toBe(true);
  });

  it("allows group-origin tapback approvals only after exec forwarding and approvers are configured", () => {
    const request = buildExecRequest(GROUP_TARGET);
    const withoutApprovers = buildConfig({ approvals: { exec: { enabled: true } } });
    const withApprovers = buildConfig({
      imessage: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });

    expect(resolveExecOrigin(withoutApprovers, request)).toBeNull();
    expect(resolveExecOrigin(withApprovers, request)).toEqual({
      to: GROUP_TARGET,
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });
});

describe("shouldSuppressLocalIMessageExecApprovalPrompt", () => {
  it("suppresses eligible session-mode exec approval prompts", () => {
    const cfg = buildConfig({
      imessage: { allowFrom: ["+15551230000"] },
      approvals: {
        exec: {
          enabled: true,
          agentFilter: ["main"],
        },
      },
    });

    expect(
      suppressLocalSessionPrompt(cfg, "agent:main:imessage:+15551230000", {
        accountId: DEFAULT_ACCOUNT_ID,
        agentId: null,
      }),
    ).toBe(true);
  });

  it("keeps local prompts for disabled, target-only, inactive, or non-exec cases", () => {
    const enabledConfig = buildConfig({
      imessage: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });
    const payload = buildLocalApprovalPayload({
      agentId: "main",
      sessionKey: "agent:main:imessage:+15551230000",
    });
    const inactiveRoutes: Parameters<typeof suppressLocalPrompt>[0][] = [
      { cfg: buildConfig(), payload },
      {
        cfg: buildConfig({
          imessage: { allowFrom: ["+15551230000"] },
          approvals: { exec: { enabled: false } },
        }),
        payload,
      },
      {
        cfg: buildTargetModeConfig("exec", [{ channel: "imessage", to: DIRECT_TARGET }], {
          imessage: { allowFrom: [DIRECT_TARGET] },
        }),
        payload,
      },
      {
        cfg: enabledConfig,
        payload,
        hint: { ...ACTIVE_EXEC_HINT, nativeRouteActive: false },
      },
      {
        cfg: enabledConfig,
        payload: buildLocalApprovalPayload({ approvalKind: "plugin" }),
      },
      {
        cfg: enabledConfig,
        payload: { text: "Approval required." },
      },
    ];

    for (const route of inactiveRoutes) {
      expect(suppressLocalPrompt(route)).toBe(false);
    }
  });

  it("suppresses direct same-chat iMessage prompts without explicit approvers", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    for (const [sessionKey, accountId] of [
      ["agent:main:imessage:+15551230000", undefined],
      ["agent:main:imessage:direct:+15551230000", DEFAULT_ACCOUNT_ID],
      ["agent:main:imessage:default:direct:+15551230000", DEFAULT_ACCOUNT_ID],
    ] as const) {
      expect(suppressLocalSessionPrompt(cfg, sessionKey, { accountId })).toBe(true);
    }
  });

  it("keeps no-approver local prompts for ambiguous or group iMessage sessions", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    for (const [sessionKey, accountId] of [
      ["agent:main:imessage:group:test-group", undefined],
      ["agent:main:imessage:chat_guid:iMessage;+;chat42", undefined],
      ["agent:main:slack:C123", undefined],
      ["agent:main:imessage:default:direct:+15551230000", "work"],
    ] as const) {
      expect(suppressLocalSessionPrompt(cfg, sessionKey, { accountId })).toBe(false);
    }
  });

  it("applies top-level approval filters with agent fallback from session key", () => {
    const cfg = buildConfig({
      imessage: { allowFrom: ["+15551230000"] },
      approvals: {
        exec: {
          enabled: true,
          agentFilter: ["ops"],
          sessionFilter: ["imessage"],
        },
      },
    });

    for (const [sessionKey, expected] of [
      ["agent:ops:imessage:+15551230000", true],
      ["agent:main:imessage:+15551230000", false],
      ["agent:ops:slack:C123", false],
    ] as const) {
      expect(suppressLocalSessionPrompt(cfg, sessionKey, { agentId: null })).toBe(expected);
    }
  });
});
