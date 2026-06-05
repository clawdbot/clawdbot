// Imessage tests cover approval native plugin behavior.
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  imessageApprovalCapability,
  imessageNativeApprovalAdapter,
  shouldSuppressLocalIMessageExecApprovalPrompt,
} from "./approval-native.js";

type IMessageConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]>;

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
  request: ExecApprovalRequest | PluginApprovalRequest;
  accountId?: string | null;
}) {
  return imessageApprovalCapability.nativeRuntime?.availability.shouldHandle({
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

describe("imessage approval capability", () => {
  it("disables native approvals when no top-level approvals config is set", () => {
    const cfg = buildConfig();
    const execRequest = buildExecRequest("+15551230000");
    const pluginRequest = buildPluginRequest("+15551230000");

    expect(
      imessageNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      imessageApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: execRequest,
      }).enabled,
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, request: execRequest })).toBe(false);
    expect(nativeShouldHandle({ cfg, request: pluginRequest })).toBe(false);
  });

  it("allows session-mode exec delivery for matching iMessage origins", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("+15551230000");

    expect(
      imessageApprovalCapability.native?.describeDeliveryCapabilities({
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

  it("does not use session mode for non-iMessage-origin requests", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("", {
      turnSourceChannel: "slack",
      turnSourceTo: "C123",
      sessionKey: "agent:main:slack:channel:c123",
    });

    expect(nativeShouldHandle({ cfg, request })).toBe(false);
    expect(
      imessageApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);
  });

  it("rejects group origin targets when no approvers are configured", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("chat_guid:iMessage;+;chat42");

    expect(
      imessageApprovalCapability.native?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toBeNull();
  });

  it("allows group origin targets when explicit approvers are configured", () => {
    const cfg = buildConfig({
      imessage: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });
    const request = buildExecRequest("chat_guid:iMessage;+;chat42");

    expect(
      imessageApprovalCapability.native?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: "chat_guid:iMessage;+;chat42",
      accountId: "default",
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
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "imessage", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000");

    expect(
      imessageNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      imessageApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "default",
        context: {},
      }),
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, request })).toBe(false);
  });

  it("disables delivery when the iMessage channel is disabled", () => {
    const cfg = buildConfig({
      imessage: { enabled: false },
      approvals: { exec: { enabled: true } },
    });
    const request = buildExecRequest("+15551230000");

    expect(
      imessageApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, request })).toBe(false);
  });

  it("renders thumbs-only reaction hints in exec approval prompts", () => {
    const payload = imessageApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg: buildConfig(),
      request: buildExecRequest("+15551230000"),
      target: { channel: "imessage", to: "+15551230000", source: "target" },
      nowMs: 0,
    });

    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
  });

  it("renders thumbs-only reaction hints in plugin approval prompts and respects allowed decisions", () => {
    const payload = imessageApprovalCapability.render?.plugin?.buildPendingPayload?.({
      cfg: buildConfig(),
      request: buildPluginRequest("+15551230000", {
        allowedDecisions: ["allow-once", "deny"],
      }) as never,
      target: { channel: "imessage", to: "+15551230000", source: "target" },
      nowMs: 0,
    });

    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
    expect(payload?.text).not.toContain("Allow Always");
  });

  it("renders target-mode exec prompts with concrete thumbs-only reaction choices", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "imessage", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000", {
      ask: "always",
      cwd: "/tmp/work",
      host: "gateway",
    });

    const payload = imessageApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg,
      request,
      target: { channel: "imessage", to: "+15551230000", source: "target" },
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
    const cfg = buildConfig({
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "imessage", to: "+15551230000" }],
        },
      },
    });
    const request = buildPluginRequest("+15551230000", {
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const payload = imessageApprovalCapability.render?.plugin?.buildPendingPayload?.({
      cfg,
      request: request as never,
      target: { channel: "imessage", to: "+15551230000", source: "target" },
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
      imessageNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
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
      sessionKey: "agent:main:imessage:+15551230000",
    });
    const blockedByAgent = buildConfig({
      approvals: { exec: { enabled: true, agentFilter: ["other"] } },
    });
    const blockedBySession = buildConfig({
      approvals: { exec: { enabled: true, sessionFilter: ["telegram"] } },
    });

    expect(nativeShouldHandle({ cfg: blockedByAgent, request })).toBe(false);
    expect(nativeShouldHandle({ cfg: blockedBySession, request })).toBe(false);
  });

  it("matches account-scoped top-level iMessage targets only for that account", () => {
    const cfg = buildConfig({
      imessage: {
        accounts: {
          work: { enabled: true },
        },
      } as Partial<IMessageConfig>,
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "imessage", to: "+15551230000", accountId: "work" }],
        },
      },
    });

    expect(
      imessageNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      imessageNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
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
    const shouldSuppress = imessageApprovalCapability.delivery?.shouldSuppressForwardingFallback;

    expect(
      shouldSuppress?.({
        cfg,
        approvalKind: "exec",
        target: {
          channel: "imessage",
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
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "imessage", to: "+15550000000" }],
        },
      },
    });

    expect(
      imessageApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "imessage", to: "+15550000000", source: "target" },
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
          targets: [{ channel: "imessage", to: "+15551230000" }],
        },
      },
    });

    expect(
      imessageApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "imessage", to: "+15551230000", source: "target" },
        request: buildExecRequest("+15551230000"),
      }),
    ).toBe(true);
  });

  it("suppresses both-mode unscoped targets through the configured default iMessage account", () => {
    const cfg = buildConfig({
      imessage: {
        defaultAccount: "work",
        accounts: {
          default: { enabled: true },
          work: { enabled: true },
        },
      } as Partial<IMessageConfig>,
      approvals: {
        exec: {
          enabled: true,
          mode: "both",
          targets: [{ channel: "imessage", to: "+15551230000" }],
        },
      },
    });

    expect(
      imessageApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "imessage", to: "+15551230000", source: "target" },
        request: buildExecRequest("+15551230000", {
          turnSourceAccountId: "work",
        }),
      }),
    ).toBe(true);
  });

  it("allows group-origin tapback approvals only after exec forwarding and approvers are configured", () => {
    const request = buildExecRequest("chat_guid:iMessage;+;chat42");
    const withoutApprovers = buildConfig({ approvals: { exec: { enabled: true } } });
    const withApprovers = buildConfig({
      imessage: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });

    expect(
      imessageApprovalCapability.native?.resolveOriginTarget?.({
        cfg: withoutApprovers,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toBeNull();
    expect(
      imessageApprovalCapability.native?.resolveOriginTarget?.({
        cfg: withApprovers,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: "chat_guid:iMessage;+;chat42",
      accountId: "default",
    });
  });
});

describe("shouldSuppressLocalIMessageExecApprovalPrompt", () => {
  const activeExecHint = {
    kind: "approval-pending",
    approvalKind: "exec",
    nativeRouteActive: true,
  } as const;

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
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        accountId: "default",
        payload: buildLocalApprovalPayload({
          agentId: null,
          sessionKey: "agent:main:imessage:+15551230000",
        }),
        hint: activeExecHint,
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

    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg: buildConfig(),
        payload,
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg: buildConfig({
          imessage: { allowFrom: ["+15551230000"] },
          approvals: { exec: { enabled: false } },
        }),
        payload,
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg: buildConfig({
          imessage: { allowFrom: ["+15551230000"] },
          approvals: {
            exec: {
              enabled: true,
              mode: "targets",
              targets: [{ channel: "imessage", to: "+15551230000" }],
            },
          },
        }),
        payload,
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg: enabledConfig,
        payload,
        hint: { ...activeExecHint, nativeRouteActive: false },
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg: enabledConfig,
        payload: buildLocalApprovalPayload({ approvalKind: "plugin" }),
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg: enabledConfig,
        payload: { text: "Approval required." },
        hint: activeExecHint,
      }),
    ).toBe(false);
  });

  it("suppresses direct same-chat iMessage prompts without explicit approvers", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:imessage:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(true);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        accountId: "default",
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:imessage:direct:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(true);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        accountId: "default",
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:imessage:default:direct:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(true);
  });

  it("keeps no-approver local prompts for ambiguous or group iMessage sessions", () => {
    const cfg = buildConfig({
      approvals: { exec: { enabled: true } },
    });

    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:imessage:group:test-group",
        }),
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:imessage:chat_guid:iMessage;+;chat42",
        }),
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:slack:C123",
        }),
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        accountId: "work",
        payload: buildLocalApprovalPayload({
          agentId: "main",
          sessionKey: "agent:main:imessage:default:direct:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(false);
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

    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: null,
          sessionKey: "agent:ops:imessage:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(true);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
        cfg,
        payload: buildLocalApprovalPayload({
          agentId: null,
          sessionKey: "agent:main:imessage:+15551230000",
        }),
        hint: activeExecHint,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalIMessageExecApprovalPrompt({
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
