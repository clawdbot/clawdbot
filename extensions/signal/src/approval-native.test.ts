// Signal tests cover approval native plugin behavior.
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  shouldSuppressLocalSignalExecApprovalPrompt,
  signalApprovalCapability,
  signalNativeApprovalAdapter,
} from "./approval-native.js";

type SignalConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>;

function buildConfig(
  params: {
    signal?: Partial<SignalConfig>;
    approvals?: OpenClawConfig["approvals"];
  } = {},
): OpenClawConfig {
  return {
    channels: {
      signal: {
        enabled: true,
        ...params.signal,
      },
    },
    approvals: params.approvals,
  } as OpenClawConfig;
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
      turnSourceChannel: "signal",
      turnSourceTo,
      turnSourceAccountId: "default",
      sessionKey: `agent:main:signal:${turnSourceTo}`,
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
      turnSourceChannel: "signal",
      turnSourceTo,
      turnSourceAccountId: "default",
      sessionKey: `agent:main:signal:${turnSourceTo}`,
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

function nativeShouldHandle(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest | PluginApprovalRequest;
  accountId?: string | null;
}) {
  return signalApprovalCapability.nativeRuntime?.availability.shouldHandle({
    cfg: params.cfg,
    accountId: params.accountId ?? "default",
    context: {},
    request: params.request,
  });
}

function buildLocalApprovalPayload(
  params: {
    approvalKind?: "exec" | "plugin";
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

describe("signal approval capability", () => {
  it("does not enable exec or plugin native approvals from Signal readiness alone", () => {
    const cfg = buildConfig();
    const execRequest = buildExecRequest("+15551230000");
    const pluginRequest = buildPluginRequest("+15551230000");

    expect(
      signalNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      signalNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      signalApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: execRequest,
      }).enabled,
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, request: execRequest })).toBe(false);
    expect(nativeShouldHandle({ cfg, request: pluginRequest })).toBe(false);
  });

  it("allows session-mode exec delivery for matching Signal origins", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("+15551230000");

    expect(
      signalApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: false,
      notifyOriginWhenDmOnly: true,
    });
    expect(nativeShouldHandle({ cfg, request })).toBe(true);
  });

  it("requires explicit approvers before delivering group-origin approvals", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("group:g1");

    expect(
      signalApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);

    const withApprover = buildConfig({
      signal: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });
    expect(
      signalApprovalCapability.native?.describeDeliveryCapabilities({
        cfg: withApprover,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(true);
  });

  it("keeps exec and plugin forwarding gates independent", () => {
    const execOnly = buildConfig({ approvals: { exec: { enabled: true } } });
    const pluginOnly = buildConfig({ approvals: { plugin: { enabled: true } } });

    expect(nativeShouldHandle({ cfg: execOnly, request: buildPluginRequest("+15551230000") })).toBe(
      false,
    );
    expect(nativeShouldHandle({ cfg: pluginOnly, request: buildExecRequest("+15551230000") })).toBe(
      false,
    );
    expect(
      nativeShouldHandle({ cfg: pluginOnly, request: buildPluginRequest("+15551230000") }),
    ).toBe(true);
  });

  it("does not use session mode for non-Signal-origin requests", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("", {
      turnSourceChannel: "slack",
      turnSourceTo: "C123",
      sessionKey: "agent:main:slack:channel:c123",
    });

    expect(nativeShouldHandle({ cfg, request })).toBe(false);
    expect(
      signalApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);
  });

  it("uses target-mode config for requestless availability without native runtime handling", () => {
    const cfg = buildConfig({
      signal: { allowFrom: ["+15551230000"] },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000");

    expect(
      signalNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      signalApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "default",
        context: {},
      }),
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, request })).toBe(false);
    expect(
      signalApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);
  });

  it("renders target-mode exec prompts without unbound reaction choices", () => {
    const cfg = buildConfig({
      signal: { allowFrom: ["+15551230000"] },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000", {
      ask: "always",
      cwd: "/tmp/work",
      host: "gateway",
    });

    const payload = signalApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "signal", to: "+15551230000", source: "target" },
      nowMs: 0,
    });
    const text = payload?.text ?? "";

    expect(text).toContain("/approve exec-1 allow-once");
    expect(text).not.toContain("React with:");
    expect(text).not.toContain("👍 Allow Once");
    expect(text).not.toContain("👎 Deny");
    expect(text).not.toContain("<id>");
    expect(text).not.toContain("1️⃣ Allow Once");
    expect(text).not.toContain("2️⃣ Allow Always");
    expect(text).not.toContain("3️⃣ Deny");
  });

  it("does not show reaction choices when Signal has no explicit approvers", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000");

    const payload = signalApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "signal", to: "+15551230000", source: "target" },
      nowMs: 0,
    });
    const text = payload?.text ?? "";

    expect(text).toContain("/approve exec-1 allow-once");
    expect(text).not.toContain("React with:");
    expect(text).not.toContain("👍 Allow Once");
    expect(text).not.toContain("👎 Deny");
  });

  it("normalizes equivalent Signal UUID target forms without suppressing generic target delivery", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "uuid:ABCDEF12-3456-7890-ABCD-EF1234567890" }],
        },
      },
    });
    const request = buildExecRequest("abcdef12-3456-7890-abcd-ef1234567890", {
      turnSourceChannel: "slack",
      turnSourceTo: "C123",
      sessionKey: "agent:main:slack:channel:c123",
    });

    expect(
      signalApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        request,
        target: {
          channel: "signal",
          to: "abcdef12-3456-7890-abcd-ef1234567890",
          source: "target",
        },
      }),
    ).toBe(false);
  });
});

describe("shouldSuppressLocalSignalExecApprovalPrompt", () => {
  const activeExecHint = {
    kind: "approval-pending",
    approvalKind: "exec",
    nativeRouteActive: true,
  } as const;

  it("suppresses eligible session-mode exec approval prompts", () => {
    const cfg = buildConfig({
      signal: { allowFrom: ["+15551230000"] },
      approvals: {
        exec: {
          enabled: true,
          agentFilter: ["main"],
        },
      },
    });

    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg,
        accountId: "default",
        payload: buildLocalApprovalPayload({
          agentId: null,
          sessionKey: "agent:main:signal:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(true);
  });

  it("keeps local prompts for disabled, ambiguous, or non-exec cases", () => {
    const enabledConfig = buildConfig({
      signal: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });
    const payload = buildLocalApprovalPayload({
      agentId: "main",
      sessionKey: "agent:main:signal:+15551230000",
    });

    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg: buildConfig(),
        payload,
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg: buildConfig({
          signal: { allowFrom: ["+15551230000"] },
          approvals: { exec: { enabled: false } },
        }),
        payload,
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg: buildConfig({
          signal: { allowFrom: ["+15551230000"] },
          approvals: {
            exec: {
              enabled: true,
              mode: "targets",
              targets: [{ channel: "signal", to: "+15551230000" }],
            },
          },
        }),
        payload,
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg: enabledConfig,
        payload,
        hint: { ...activeExecHint, nativeRouteActive: false },
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg: enabledConfig,
        payload: buildLocalApprovalPayload({ approvalKind: "plugin" }),
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg: enabledConfig,
        payload: { text: "Approval required." },
        hint: activeExecHint,
      }),
    ).toBe(false);
  });

  it("suppresses direct same-chat Signal prompts without explicit approvers", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:signal:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(true);
  });

  it("keeps no-approver local prompts for ambiguous or group Signal sessions", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:signal:group:test-group",
        }),
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:slack:C123",
        }),
        hint: activeExecHint,
      }),
    ).toBe(false);
  });

  it("applies top-level approval filters with agent fallback from session key", () => {
    const cfg = buildConfig({
      signal: { allowFrom: ["+15551230000"] },
      approvals: {
        exec: {
          enabled: true,
          agentFilter: ["ops"],
          sessionFilter: ["signal"],
        },
      },
    });

    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: null,
          sessionKey: "agent:ops:signal:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(true);
    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: null,
          sessionKey: "agent:main:signal:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalSignalExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: null,
          sessionKey: "agent:ops:slack:C123",
        }),
        hint: activeExecHint,
      }),
    ).toBe(false);
  });
});
