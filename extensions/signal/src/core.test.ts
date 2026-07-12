import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
// Signal tests cover core plugin behavior.
import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginSetupWizardStatus } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  clearSignalApprovalReactionTargetsForTest,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import { signalPlugin } from "./channel.js";
import * as clientModule from "./client-adapter.js";
import { classifySignalCliLogLine } from "./daemon.js";
import {
  looksLikeUuid,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "./identity.js";
import { probeSignal } from "./probe.js";
import {
  clearSignalReplyAuthorsForTest,
  registerSignalReplyContext,
  resolveSignalReplyContextWithPersistence,
} from "./reply-authors.js";
import { clearSignalRuntime } from "./runtime.js";
import {
  createSignalCliPathTextInput,
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  signalDmPolicy,
} from "./setup-core.js";

const getSignalSetupStatus = createPluginSetupWizardStatus(signalPlugin);

describe("looksLikeUuid", () => {
  it("accepts hyphenated UUIDs", () => {
    expect(looksLikeUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("accepts compact UUIDs", () => {
    expect(looksLikeUuid("123e4567e89b12d3a456426614174000")).toBe(true); // pragma: allowlist secret
  });

  it("accepts uuid-like hex values with letters", () => {
    expect(looksLikeUuid("abcd-1234")).toBe(true);
  });

  it("rejects numeric ids and phone-like values", () => {
    expect(looksLikeUuid("1234567890")).toBe(false);
    expect(looksLikeUuid("+15555551212")).toBe(false);
  });
});

describe("signal sender identity", () => {
  it("prefers sourceNumber over sourceUuid", () => {
    const sender = resolveSignalSender({
      sourceNumber: " +15550001111 ",
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+15550001111",
      e164: "+15550001111",
    });
  });

  it("uses sourceUuid when sourceNumber is missing", () => {
    const sender = resolveSignalSender({
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "uuid",
      raw: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("falls back to sourceUuid when sourceNumber has no digits", () => {
    const sender = resolveSignalSender({
      sourceNumber: "not a phone number",
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "uuid",
      raw: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("normalizes noisy allowlist numbers and rejects digit-free entries", () => {
    expect(normalizeSignalAllowRecipient("signal:++1 (555) 000-1111")).toBe("+15550001111");
    expect(normalizeSignalAllowRecipient("signal:not a phone number")).toBeUndefined();
  });

  it("maps uuid senders to recipient and peer ids", () => {
    const sender = { kind: "uuid", raw: "123e4567-e89b-12d3-a456-426614174000" } as const;
    expect(resolveSignalRecipient(sender)).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(resolveSignalPeerId(sender)).toBe("uuid:123e4567-e89b-12d3-a456-426614174000");
  });
});

describe("probeSignal", () => {
  it("falls back to the direct probe helper when runtime is not initialized", async () => {
    clearSignalRuntime();
    vi.spyOn(clientModule, "signalCheck")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        error: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        error: null,
      });
    vi.spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" })
      .mockResolvedValueOnce({ version: "0.13.22" });

    const params = {
      cfg: {} as never,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:8080",
      } as never,
      timeoutMs: 1000,
    };

    const expected = await probeSignal("http://127.0.0.1:8080", 1000);
    const result = await signalPlugin.status!.probeAccount!(params);

    expect(result.ok).toBe(expected.ok);
    expect(result.status).toBe(expected.status);
    expect(result.error).toBe(expected.error);
    expect(result.version).toBe(expected.version);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("extracts version from {version} result", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: true,
      status: 200,
      error: null,
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.13.22");
    expect(res.status).toBe(200);
  });

  it("returns ok=false when /check fails", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.version).toBe(null);
  });

  it("setup status lines use the selected account cliPath", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/root-signal-cli",
            accounts: {
              work: {
                cliPath: "/tmp/work-signal-cli",
              },
            },
          },
        },
      } as never,
      accountOverrides: { signal: "work" },
    });

    expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
  });

  it("setup status uses configured defaultAccount for omitted cliPath lookup", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/root-signal-cli",
            defaultAccount: "work",
            accounts: {
              work: {
                cliPath: "/tmp/work-signal-cli",
              },
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            cliPath: "/tmp/root-signal-cli",
            accounts: {
              alerts: {
                cliPath: "/tmp/alerts-signal-cli",
              },
              work: {
                cliPath: "",
                account: "",
                httpHost: "",
                httpUrl: "",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });

  it("does not show a second missing-binary note before the cliPath prompt", () => {
    const input = createSignalCliPathTextInput(async () => true);

    expect(input.helpLines).toBeUndefined();
    expect(input.helpTitle).toBeUndefined();
  });
});

describe("signal outbound", () => {
  it("resolves aliases through the message target resolver", async () => {
    const resolved = await signalPlugin.messaging?.targetResolver?.resolveTarget?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              ops: "signal:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
            },
          },
        },
      } as OpenClawConfig,
      input: "signal:ops",
      normalized: "ops",
      preferredKind: "group",
    });

    expect(resolved).toEqual({
      to: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      kind: "group",
      display: "ops",
      source: "directory",
    });
  });

  it("resolves aliases through sync outbound target resolution", () => {
    const resolved = signalPlugin.outbound?.resolveTarget?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              me: "+15551234567",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:me",
      accountId: "default",
    });

    expect(resolved).toEqual({ ok: true, to: "+15551234567" });
  });

  it("keeps Signal outbound text sanitization enabled", () => {
    expect(
      signalPlugin.outbound?.sanitizeText?.({
        text: "<think>private reasoning</think>\nVisible answer",
        payload: { text: "Visible answer" },
      }),
    ).toBe("Visible answer");
  });

  it("resolves aliases before durable Signal message sends", async () => {
    const send = vi.fn(async () => ({
      messageId: "signal-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "signal", messageId: "signal-1" }],
        kind: "text",
      }),
    }));

    await signalPlugin.message?.send?.text?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              me: "+15551234567",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:me",
      text: "approval",
      deps: { signal: send },
    });

    expect(send).toHaveBeenCalledWith(
      "+15551234567",
      "approval",
      expect.objectContaining({
        cfg: expect.any(Object),
      }),
    );
  });

  it("resolves aliases before formatted Signal sends", async () => {
    const send = vi.fn(async () => ({
      messageId: "signal-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "signal", messageId: "signal-1" }],
        kind: "text",
      }),
    }));

    await signalPlugin.outbound?.sendFormattedText?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:ops",
      text: "approval",
      deps: { signal: send },
    });

    expect(send).toHaveBeenCalledWith(
      "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      "approval",
      expect.objectContaining({
        cfg: expect.any(Object),
      }),
    );
  });

  it("reports a formatted Signal chunk before a later chunk fails", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "signal-1" })
      .mockRejectedValueOnce(new Error("second Signal chunk failed"));
    const onDeliveryResult = vi.fn();

    await expect(
      signalPlugin.outbound?.sendFormattedText?.({
        cfg: { channels: { signal: { replyToMode: "first" } } } as OpenClawConfig,
        to: "+15551234567",
        text: "a".repeat(5000),
        deps: { signal: send },
        replyToId: "1700000000004",
        replyToIdSource: "implicit",
        onDeliveryResult,
      }),
    ).rejects.toThrow("second Signal chunk failed");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      2,
      "+15551234567",
      expect.any(String),
      expect.not.objectContaining({
        replyToId: "1700000000004",
      }),
    );
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "signal", messageId: "signal-1" }),
    );
  });

  it("resolves aliases before formatted Signal media sends", async () => {
    const send = vi.fn(async () => ({
      messageId: "signal-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "signal", messageId: "signal-1" }],
        kind: "media",
      }),
    }));

    await signalPlugin.outbound?.sendFormattedMedia?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:ops",
      text: "approval",
      mediaUrl: "file:///tmp/signal-proof.png",
      deps: { signal: send },
    });

    expect(send).toHaveBeenCalledWith(
      "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      "approval",
      expect.objectContaining({
        cfg: expect.any(Object),
        mediaUrl: "file:///tmp/signal-proof.png",
      }),
    );
  });

  it("returns clear outbound errors for recursive aliases", () => {
    const resolved = signalPlugin.outbound?.resolveTarget?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              home: "signal:me",
              me: "home",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:home",
    });

    expect(resolved?.ok).toBe(false);
    if (resolved?.ok === false) {
      expect(resolved.error.message).toBe(
        'Signal alias "home" resolves recursively through "home".',
      );
    }
  });

  it("returns target resolver misses for recursive aliases", async () => {
    const resolved = await signalPlugin.messaging?.targetResolver?.resolveTarget?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              home: "signal:me",
              me: "home",
            },
          },
        },
      } as OpenClawConfig,
      input: "signal:home",
      normalized: "home",
      preferredKind: "user",
    });

    expect(resolved).toBeNull();
  });

  it("returns clear outbound errors for recursive defaultTo aliases", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            home: "signal:me",
            me: "home",
          },
          defaultTo: "signal:home",
        },
      },
    } as OpenClawConfig;

    const defaultTo = signalPlugin.config.resolveDefaultTo?.({
      cfg,
      accountId: "default",
    });
    expect(defaultTo).toBe("signal:home");

    const resolved = signalPlugin.outbound?.resolveTarget?.({
      cfg,
      to: defaultTo,
      accountId: "default",
    });

    expect(resolved?.ok).toBe(false);
    if (resolved?.ok === false) {
      expect(resolved.error.message).toBe(
        'Signal alias "home" resolves recursively through "home".',
      );
    }
  });

  it("builds canonical session routes for aliases", async () => {
    const route = await signalPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
            },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      target: "signal:ops",
      resolvedTarget: {
        to: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
        kind: "group",
        source: "directory",
      },
    });

    expect(route?.to).toBe("group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=");
    expect(route?.baseSessionKey).toContain(
      "signal:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
    );
  });

  it("lists configured aliases through the Signal directory", async () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            me: "+15551234567",
            ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      signalPlugin.directory?.listPeers?.({ cfg, query: "me", runtime: {} as never }),
    ).resolves.toEqual([{ kind: "user", id: "+15551234567", name: "me" }]);
    await expect(
      signalPlugin.directory?.listGroups?.({ cfg, query: "ops", runtime: {} as never }),
    ).resolves.toEqual([
      {
        kind: "group",
        id: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
        name: "ops",
      },
    ]);
  });

  it("resolves account and chat-type scoped reply-to modes through plugin threading", () => {
    const resolveReplyToMode = signalPlugin.threading?.resolveReplyToMode;
    if (!resolveReplyToMode) {
      throw new Error("signal threading.resolveReplyToMode unavailable");
    }

    const cfg = {
      channels: {
        signal: {
          replyToMode: "first",
          replyToModeByChatType: { direct: "all", group: "off" },
          accounts: {
            Work: {
              replyToMode: "off",
              replyToModeByChatType: { group: "all" },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveReplyToMode({ cfg, accountId: "work", chatType: "group" })).toBe("all");
    expect(resolveReplyToMode({ cfg, accountId: "work", chatType: "direct" })).toBe("off");
    expect(resolveReplyToMode({ cfg, accountId: "default", chatType: "direct" })).toBe("all");
    expect(resolveReplyToMode({ cfg, accountId: "default", chatType: "group" })).toBe("off");
    expect(resolveReplyToMode({ cfg, accountId: "default" })).toBe("first");
  });

  it("builds same-conversation reply context for message tool sends", () => {
    const buildToolContext = signalPlugin.threading?.buildToolContext;
    if (!buildToolContext) {
      throw new Error("signal threading.buildToolContext unavailable");
    }

    const hasRepliedRef = { value: false };
    const context = buildToolContext({
      cfg: {
        channels: {
          signal: {
            replyToModeByChatType: { direct: "first" },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      context: {
        Channel: "signal",
        To: "signal:+15550001111",
        ChatType: "direct",
        CurrentMessageId: "1783831798122",
        ReplyToId: "1783831798000",
      },
      hasRepliedRef,
    });
    if (!context) {
      throw new Error("signal threading tool context unavailable");
    }

    expect(context).toEqual({
      currentChannelId: "signal:+15550001111",
      currentChatType: "direct",
      currentMessagingTarget: "signal:+15550001111",
      currentMessageId: "1783831798000",
      replyToMode: "first",
      hasRepliedRef,
    });
    expect(
      signalPlugin.threading?.matchesToolContextTarget?.({
        target: "+15550001111",
        toolContext: context,
      }),
    ).toBe(true);
  });

  it("chunks outbound text without requiring Signal runtime initialization", () => {
    clearSignalRuntime();
    const chunker = signalPlugin.outbound?.chunker;
    if (!chunker) {
      throw new Error("signal outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });

  it("sanitizes internal assistant scaffolding before outbound delivery", () => {
    const sanitizeText = signalPlugin.outbound?.sanitizeText;
    if (!sanitizeText) {
      throw new Error("signal outbound sanitizer unavailable");
    }

    expect(
      sanitizeText({
        text: "<think>private</think>Visible answer",
        payload: { text: "<think>private</think>Visible answer" },
      }),
    ).toBe("Visible answer");
  });

  it("preserves the local approval prompt suppressor through attached-result composition", () => {
    const suppressor = signalPlugin.outbound?.shouldSuppressLocalPayloadPrompt;
    if (!suppressor) {
      throw new Error("signal outbound approval suppressor unavailable");
    }

    expect(
      suppressor({
        cfg: {
          channels: {
            signal: {
              enabled: true,
              allowFrom: ["+15551230000"],
            },
          },
          approvals: {
            exec: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        payload: {
          text: "Approval required.",
          channelData: {
            execApproval: {
              approvalId: "exec-1",
              approvalSlug: "exec-1",
              approvalKind: "exec",
              sessionKey: "agent:main:signal:+15551230000",
            },
          },
        },
        hint: {
          kind: "approval-pending",
          approvalKind: "exec",
          nativeRouteActive: true,
        },
      }),
    ).toBe(true);
  });

  it("registers structured approval payloads for reactions after delivery", async () => {
    clearSignalApprovalReactionTargetsForTest();
    const cfg = {
      channels: {
        signal: {
          account: "+15550009999",
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-after-delivery",
      approvalSlug: "exec-aft",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });
    const rendered = await signalPlugin.outbound?.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg,
        to: "+15551230000",
        text: payload.text ?? "",
        accountId: "default",
        payload,
      },
    });
    expect(rendered?.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");

    await signalPlugin.outbound?.afterDeliverPayload?.({
      cfg,
      target: {
        channel: "signal",
        to: "+15551230000",
        accountId: "default",
      },
      payload: rendered!,
      results: [
        {
          channel: "signal",
          messageId: "1700000000099",
        },
      ],
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000099",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toEqual({
      approvalId: "exec-after-delivery",
      approvalKind: "exec",
      decision: "allow-once",
      route: {
        deliveryMode: "target",
        to: "+15551230000",
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:signal:direct:+15551230000",
      },
    });
  });

  it("renders reaction hints only from structured approval payloads", async () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15550009999",
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-rendered-approval",
      approvalSlug: "exec-ren",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
    });
    const rendered = await signalPlugin.outbound?.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg,
        to: "+15551230000",
        text: payload.text ?? "",
        accountId: "default",
        payload,
      },
    });

    expect(rendered?.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    expect(
      await signalPlugin.outbound?.renderPresentation?.({
        payload: {
          text: [
            "The docs show this example:",
            "Exec approval required",
            "ID: exec-rendered-approval",
            "",
            "Reply with: /approve exec-rendered-approval allow-once|deny",
          ].join("\n"),
          presentation: payload.presentation,
        },
        presentation: payload.presentation!,
        ctx: {
          cfg,
          to: "+15551230000",
          text: payload.text ?? "",
          accountId: "default",
          payload,
        },
      }),
    ).toBeNull();
  });

  it("materializes mixed approval presentation before adding reaction guidance", async () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15550009999",
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-mixed-presentation",
      approvalSlug: "exec-mixed-presentation",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
    });
    const presentation = {
      ...payload.presentation!,
      blocks: [
        { type: "context" as const, text: "Deployment audit context" },
        {
          type: "table" as const,
          caption: "Targets",
          headers: ["Host", "State"],
          rows: [
            ["alpha", "ready"],
            ["omega", "waiting"],
          ],
        },
        ...payload.presentation!.blocks,
      ],
    };

    const rendered = await signalPlugin.outbound?.renderPresentation?.({
      payload: { ...payload, presentation },
      presentation,
      ctx: {
        cfg,
        to: "+15551230000",
        text: payload.text ?? "",
        accountId: "default",
        payload,
      },
    });

    expect(rendered?.text).toContain("Deployment audit context");
    expect(rendered?.text).toContain("- Host: alpha; State: ready");
    expect(rendered?.text).toContain("- Host: omega; State: waiting");
    expect(rendered?.text?.match(/React with:/g)).toHaveLength(1);
    expect(rendered?.text?.match(/\/approve exec-mixed-presentation allow-once/g)).toHaveLength(1);
    expect(rendered?.text?.match(/\/approve exec-mixed-presentation deny/g)).toHaveLength(1);
    expect(rendered?.text).not.toContain("- Allow Once:");
    expect(rendered?.text).not.toContain("- Deny:");
  });

  it("registers delivered approval reactions under the resolved default account", async () => {
    const renderPresentation = signalPlugin.outbound?.renderPresentation;
    const afterDeliverPayload = signalPlugin.outbound?.afterDeliverPayload;
    if (!renderPresentation || !afterDeliverPayload) {
      throw new Error("signal outbound approval delivery hooks unavailable");
    }

    clearSignalApprovalReactionTargetsForTest();
    const cfg = {
      channels: {
        signal: {
          defaultAccount: "work",
          accounts: {
            work: {
              accountUuid: "123e4567-e89b-12d3-a456-426614174000",
              allowFrom: ["+15551230000"],
            },
          },
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload: ReplyPayload = {
      text: ["Exec approval required", "ID: exec-1"].join("\n"),
      channelData: {
        execApproval: {
          approvalId: "exec-1",
          approvalSlug: "exec-1",
          approvalKind: "exec",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    };
    const renderedPayload =
      (await renderPresentation({
        ctx: {
          cfg,
          to: "+15551230000",
          text: payload.text ?? "",
          accountId: "work",
          payload,
        },
        presentation: { blocks: [] },
        payload,
      })) ?? payload;

    expect(renderedPayload.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");

    await afterDeliverPayload({
      cfg,
      target: { channel: "signal", to: "+15551230000" },
      payload: renderedPayload,
      results: [
        {
          channel: "signal",
          messageId: "1700000000001",
          meta: { signalVisibleText: renderedPayload.text },
        },
      ],
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "work",
        conversationKey: "+15551230000",
        messageId: "1700000000001",
        reactionKey: "👍",
        targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
      }),
    ).resolves.toMatchObject({
      approvalId: "exec-1",
      decision: "allow-once",
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000001",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toBeNull();
    clearSignalApprovalReactionTargetsForTest();
  });

  it("resolves only proven direct reply authors", async () => {
    const replyContext = { to: "signal:+15551234567", replyToId: "1700000000001" };
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15551234567",
      sourceTimestamp: 100,
    });
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15550001111",
      sourceTimestamp: 200,
    });
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15551234567",
      sourceTimestamp: 300,
    });
    await expect(resolveSignalReplyContextWithPersistence(replyContext)).resolves.toEqual({
      ambiguous: true,
    });
    await clearSignalReplyAuthorsForTest();
  });

  it("keeps newer reply context when older events arrive out of order", async () => {
    const replyContext = { to: "signal:+15551234567", replyToId: "1700000000002" };
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15551234567",
      body: "newer",
      sourceTimestamp: 200,
    });
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15551234567",
      body: "older",
      sourceTimestamp: 100,
    });

    await expect(resolveSignalReplyContextWithPersistence(replyContext)).resolves.toEqual({
      author: "+15551234567",
      body: "newer",
    });
    await clearSignalReplyAuthorsForTest();
  });

  it("hydrates durable Signal sends with stored native quote context", async () => {
    await clearSignalReplyAuthorsForTest();
    await registerSignalReplyContext({
      to: "signal:+15555550123",
      replyToId: "1700000000001",
      author: "+15555550123",
      body: "original message",
    });
    const send = vi.fn(async () => ({ messageId: "signal-text-1" }));

    await signalPlugin.message?.send?.text?.({
      cfg: {} as OpenClawConfig,
      to: "signal:+15555550123",
      text: "reply",
      replyToId: "1700000000001",
      deps: { signal: send },
    } as Parameters<NonNullable<typeof signalPlugin.message.send.text>>[0] & {
      deps: { signal: typeof send };
    });

    expect(send).toHaveBeenCalledWith("+15555550123", "reply", {
      cfg: {},
      maxBytes: undefined,
      accountId: undefined,
      replyToId: "1700000000001",
      replyToAuthor: "+15555550123",
      replyToBody: "original message",
    });
    await clearSignalReplyAuthorsForTest();
  });

  it("declares message adapter durable text and media with receipt proofs", async () => {
    const send = vi.fn(async (_to: string, _text: string, opts: { mediaUrl?: string } = {}) => {
      const messageId = opts.mediaUrl ? "signal-media-1" : "signal-text-1";
      return {
        messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "signal", messageId }],
          kind: opts.mediaUrl ? "media" : "text",
        }),
      };
    });
    const deps = { signal: send };

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "signal",
      adapter: signalPlugin.message!,
      proofs: {
        text: async () => {
          const result = await signalPlugin.message?.send?.text?.({
            cfg: {} as OpenClawConfig,
            to: "signal:+15555550123",
            text: "hello",
            deps,
          } as Parameters<NonNullable<typeof signalPlugin.message.send.text>>[0] & {
            deps: typeof deps;
          });
          expect(send).toHaveBeenCalledWith("+15555550123", "hello", {
            cfg: {},
            maxBytes: undefined,
            accountId: undefined,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["signal-text-1"]);
        },
        media: async () => {
          const result = await signalPlugin.message?.send?.media?.({
            cfg: {} as OpenClawConfig,
            to: "signal:+15555550123",
            text: "image",
            mediaUrl: "https://example.com/image.png",
            deps,
          } as Parameters<NonNullable<typeof signalPlugin.message.send.media>>[0] & {
            deps: typeof deps;
          });
          expect(send).toHaveBeenCalledWith("+15555550123", "image", {
            cfg: {},
            mediaUrl: "https://example.com/image.png",
            maxBytes: undefined,
            accountId: undefined,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["signal-media-1"]);
        },
      },
    });

    expect(proofResults).toEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
      { capability: "poll", status: "not_declared" },
      { capability: "payload", status: "not_declared" },
      { capability: "silent", status: "not_declared" },
      { capability: "replyTo", status: "not_declared" },
      { capability: "thread", status: "not_declared" },
      { capability: "nativeQuote", status: "not_declared" },
      { capability: "messageSendingHooks", status: "not_declared" },
      { capability: "batch", status: "not_declared" },
      { capability: "reconcileUnknownSend", status: "not_declared" },
      { capability: "afterSendSuccess", status: "not_declared" },
      { capability: "afterCommit", status: "not_declared" },
    ]);
  });
});

describe("classifySignalCliLogLine", () => {
  it("treats INFO/DEBUG as log", () => {
    expect(classifySignalCliLogLine("INFO  DaemonCommand - Started")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG Something")).toBe("log");
  });

  it("treats routine warnings as logs and errors as error state", () => {
    expect(classifySignalCliLogLine("WARN  Something")).toBe("log");
    expect(classifySignalCliLogLine("WARNING Something")).toBe("log");
    expect(classifySignalCliLogLine("ERROR Something")).toBe("error");
  });

  it("treats failures without explicit severity as error", () => {
    expect(classifySignalCliLogLine("Failed to initialize HTTP Server - oops")).toBe("error");
    expect(classifySignalCliLogLine('Exception in thread "main"')).toBe("error");
  });

  it("returns null for empty lines", () => {
    expect(classifySignalCliLogLine("")).toBe(null);
    expect(classifySignalCliLogLine("   ")).toBe(null);
  });
});

describe("signal setup parsing", () => {
  it("accepts already normalized numbers", () => {
    expect(normalizeSignalAccountInput("+15555550123")).toBe("+15555550123");
  });

  it("normalizes valid E.164 numbers", () => {
    expect(normalizeSignalAccountInput(" +1 (555) 555-0123 ")).toBe("+15555550123");
  });

  it("rejects empty input", () => {
    expect(normalizeSignalAccountInput("   ")).toBeNull();
  });

  it("rejects invalid values", () => {
    expect(normalizeSignalAccountInput("abc")).toBeNull();
    expect(normalizeSignalAccountInput("++--")).toBeNull();
  });

  it("rejects inputs with stray + characters", () => {
    expect(normalizeSignalAccountInput("++12345")).toBeNull();
    expect(normalizeSignalAccountInput("+1+2345")).toBeNull();
  });

  it("rejects numbers that are too short or too long", () => {
    expect(normalizeSignalAccountInput("+1234")).toBeNull();
    expect(normalizeSignalAccountInput("+1234567890123456")).toBeNull();
  });

  it("parses e164, uuid and wildcard entries", () => {
    expect(
      parseSignalAllowFromEntries(
        "signal:+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000, *",
      ),
    ).toEqual({
      entries: ["+15555550123", "uuid:123e4567-e89b-12d3-a456-426614174000", "*"],
    });
  });

  it("normalizes bare uuid values", () => {
    expect(parseSignalAllowFromEntries("123e4567-e89b-12d3-a456-426614174000")).toEqual({
      entries: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
    });
  });

  it("returns validation errors for invalid entries", () => {
    expect(parseSignalAllowFromEntries("uuid:")).toEqual({
      entries: [],
      error: "Invalid uuid entry",
    });
    expect(parseSignalAllowFromEntries("invalid")).toEqual({
      entries: [],
      error: "Invalid entry: invalid",
    });
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      signalDmPolicy.getCurrent(
        {
          channels: {
            signal: {
              dmPolicy: "disabled",
              accounts: {
                work: {
                  account: "+15555550123",
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        },
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(signalDmPolicy.resolveConfigKeys?.({ channels: { signal: {} } }, "work")).toEqual({
      policyKey: "channels.signal.accounts.work.dmPolicy",
      allowFromKey: "channels.signal.accounts.work.allowFrom",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          defaultAccount: "work",
          dmPolicy: "disabled",
          allowFrom: ["+15555550123"],
          accounts: {
            work: {
              account: "+15555550999",
              dmPolicy: "allowlist",
            },
          },
        },
      },
    };

    expect(signalDmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(signalDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.signal.accounts.work.dmPolicy",
      allowFromKey: "channels.signal.accounts.work.allowFrom",
    });

    const next = signalDmPolicy.setPolicy(cfg, "open");
    expect(next.channels?.signal?.dmPolicy).toBe("disabled");
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.signal?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it('writes open policy state to the named account and stores inherited allowFrom with "*"', () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          allowFrom: ["+15555550123"],
          accounts: {
            work: {
              account: "+15555550999",
            },
          },
        },
      },
    };

    const next = signalDmPolicy.setPolicy(cfg, "open", "work");

    expect(next.channels?.signal?.dmPolicy).toBeUndefined();
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.signal?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });
});
