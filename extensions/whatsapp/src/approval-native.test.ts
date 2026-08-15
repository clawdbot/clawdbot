// Whatsapp tests cover approval native plugin behavior.
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { whatsappApprovalCapability } from "./approval-native.js";

type WhatsAppConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>;

function buildConfig(
  params: {
    whatsapp?: Partial<WhatsAppConfig>;
    approvals?: OpenClawConfig["approvals"];
  } = {},
): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        enabled: true,
        ...params.whatsapp,
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
      turnSourceChannel: "whatsapp",
      turnSourceTo,
      turnSourceAccountId: "default",
      sessionKey: `agent:main:whatsapp:${turnSourceTo}`,
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
      turnSourceChannel: "whatsapp",
      turnSourceTo,
      turnSourceAccountId: "default",
      sessionKey: `agent:main:whatsapp:${turnSourceTo}`,
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

function nativeShouldHandle(params: {
  cfg: OpenClawConfig;
  approvalKind: "exec" | "plugin";
  request: ExecApprovalRequest | PluginApprovalRequest;
  accountId?: string | null;
}) {
  return whatsappApprovalCapability.nativeRuntime?.availability.shouldHandle({
    cfg: params.cfg,
    accountId: params.accountId ?? "default",
    context: {},
    approvalKind: params.approvalKind,
    request: params.request,
  });
}

describe("whatsapp approval capability", () => {
  it("does not enable exec or plugin native approvals from WhatsApp account readiness alone", () => {
    const cfg = buildConfig();
    const execRequest = buildExecRequest("+15551230000");
    const pluginRequest = buildPluginRequest("+15551230000");

    expect(
      whatsappApprovalCapability?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      whatsappApprovalCapability?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      whatsappApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: execRequest,
      }).enabled,
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, approvalKind: "exec", request: execRequest })).toBe(false);
    expect(nativeShouldHandle({ cfg, approvalKind: "plugin", request: pluginRequest })).toBe(false);
  });

  it("allows session-mode exec delivery for matching WhatsApp origins", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("+15551230000");

    expect(
      whatsappApprovalCapability.native?.describeDeliveryCapabilities({
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
    expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(true);
  });

  it("keeps exec and plugin forwarding gates independent", () => {
    const execOnly = buildConfig({ approvals: { exec: { enabled: true } } });
    const pluginOnly = buildConfig({ approvals: { plugin: { enabled: true } } });

    expect(
      nativeShouldHandle({
        cfg: execOnly,
        approvalKind: "plugin",
        request: buildPluginRequest("+15551230000"),
      }),
    ).toBe(false);
    expect(
      nativeShouldHandle({
        cfg: pluginOnly,
        approvalKind: "exec",
        request: buildExecRequest("+15551230000"),
      }),
    ).toBe(false);
    expect(
      nativeShouldHandle({
        cfg: pluginOnly,
        approvalKind: "plugin",
        request: buildPluginRequest("+15551230000"),
      }),
    ).toBe(true);
  });

  it("does not use session mode for non-WhatsApp-origin requests", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("", {
      turnSourceChannel: "slack",
      turnSourceTo: "C123",
      sessionKey: "agent:main:slack:channel:c123",
    });

    expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(false);
    expect(
      whatsappApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);
  });

  it("uses target-mode config for requestless availability without native runtime handling", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "whatsapp", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000");

    expect(
      whatsappApprovalCapability?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      whatsappApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "default",
        context: {},
      }),
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, approvalKind: "exec", request })).toBe(false);
    expect(
      whatsappApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);
  });

  it("renders target-mode exec prompts with concrete thumbs-only reaction choices", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "whatsapp", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000", {
      ask: "always",
      cwd: "/tmp/work",
      host: "gateway",
    });

    const payload = whatsappApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "whatsapp", to: "+15551230000", source: "target" },
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
    expect(payload?.presentation).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              action: {
                type: "approval",
                approvalId: "exec-1",
                approvalKind: "exec",
                decision: "allow-once",
              },
            },
            {
              action: {
                type: "approval",
                approvalId: "exec-1",
                approvalKind: "exec",
                decision: "deny",
              },
            },
          ],
        },
      ],
    });
  });

  it("renders target-mode plugin prompts with concrete thumbs-only reaction choices", () => {
    const cfg = buildConfig({
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "whatsapp", to: "+15551230000" }],
        },
      },
    });
    const request = buildPluginRequest("+15551230000", {
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const payload = whatsappApprovalCapability.render?.plugin?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "whatsapp", to: "+15551230000", source: "target" },
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
    expect(payload?.presentation).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              action: {
                type: "approval",
                approvalId: "plugin:approval-1",
                approvalKind: "plugin",
                decision: "allow-once",
              },
            },
            {
              action: {
                type: "approval",
                approvalId: "plugin:approval-1",
                approvalKind: "plugin",
                decision: "allow-always",
              },
            },
            {
              action: {
                type: "approval",
                approvalId: "plugin:approval-1",
                approvalKind: "plugin",
                decision: "deny",
              },
            },
          ],
        },
      ],
    });
  });

  it("does not report target-mode availability when no WhatsApp target matches", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "C123" }],
        },
      },
    });

    expect(
      whatsappApprovalCapability?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("applies agent and session filters to native handling", () => {
    const request = buildExecRequest("+15551230000", {
      agentId: "main",
      sessionKey: "agent:main:whatsapp:+15551230000",
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

  it("matches account-scoped top-level WhatsApp targets only for that account", () => {
    const cfg = buildConfig({
      whatsapp: {
        accounts: {
          work: { enabled: true },
        },
      } as Partial<WhatsAppConfig>,
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "whatsapp", to: "+15551230000", accountId: "work" }],
        },
      },
    });

    expect(
      whatsappApprovalCapability?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      whatsappApprovalCapability?.getActionAvailabilityState?.({
        cfg,
        accountId: "work",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "enabled" });
  });

  it("suppresses forwarding fallback only when the exact session-origin native target matches", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("+15551230000");
    const shouldSuppress = whatsappApprovalCapability.delivery?.shouldSuppressForwardingFallback;

    expect(
      shouldSuppress?.({
        cfg,
        approvalKind: "exec",
        target: {
          channel: "whatsapp",
          to: "+15551230000",
          accountId: "default",
          source: "session",
        },
        request,
      }),
    ).toBe(true);
    expect(
      shouldSuppress?.({
        cfg,
        approvalKind: "exec",
        target: {
          channel: "whatsapp",
          to: "+15550000000",
          accountId: "default",
          source: "session",
        },
        request,
      }),
    ).toBe(false);
  });

  it("does not suppress target-only forwarding when native delivery cannot bind that target", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "whatsapp", to: "+15550000000" }],
        },
      },
    });

    expect(
      whatsappApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "whatsapp", to: "+15550000000", source: "target" },
        request: buildExecRequest("+15551230000"),
      }),
    ).toBe(false);
  });

  it("suppresses both-mode explicit targets that omit the origin account id", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "both",
          targets: [{ channel: "whatsapp", to: "+15551230000" }],
        },
      },
    });

    expect(
      whatsappApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "whatsapp", to: "+15551230000", source: "target" },
        request: buildExecRequest("+15551230000"),
      }),
    ).toBe(true);
  });

  it("suppresses both-mode unscoped targets through the configured default WhatsApp account", () => {
    const cfg = buildConfig({
      whatsapp: {
        defaultAccount: "work",
        accounts: {
          default: { enabled: true },
          work: { enabled: true },
        },
      } as Partial<WhatsAppConfig>,
      approvals: {
        exec: {
          enabled: true,
          mode: "both",
          targets: [{ channel: "whatsapp", to: "+15551230000" }],
        },
      },
    });

    expect(
      whatsappApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "whatsapp", to: "+15551230000", source: "target" },
        request: buildExecRequest("+15551230000", {
          turnSourceAccountId: "work",
        }),
      }),
    ).toBe(true);
  });

  it("allows group-origin emoji approvals only after exec forwarding and approvers are configured", () => {
    const request = buildExecRequest("120363401234567890@g.us");
    const withoutApprovers = buildConfig({ approvals: { exec: { enabled: true } } });
    const withApprovers = buildConfig({
      whatsapp: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });

    expect(
      whatsappApprovalCapability.native?.resolveOriginTarget?.({
        cfg: withoutApprovers,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toBeNull();
    expect(
      whatsappApprovalCapability.native?.resolveOriginTarget?.({
        cfg: withApprovers,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: "120363401234567890@g.us",
      accountId: "default",
    });
  });
});
