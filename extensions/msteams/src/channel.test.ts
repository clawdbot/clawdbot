// Msteams tests cover channel plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";
import { msteamsDirectoryContractPlugin } from "../directory-contract-api.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import { msTeamsApprovalCapability } from "./approval-native.js";
import { msteamsPlugin } from "./channel.js";
import { msteamsSetupPlugin } from "./channel.setup.js";

function createConfiguredMSTeamsCfg(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        appId: "app-id",
        appPassword: "secret",
        tenantId: "tenant-id",
      },
    },
  };
}

describe("msteamsPlugin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("distinguishes users from channel and group conversations", () => {
    const infer = msteamsPlugin.messaging?.inferTargetChatType;
    const ownerId = "00000000-0000-0000-0000-000000000001";
    expect(infer?.({ to: ownerId })).toBe("direct");
    expect(infer?.({ to: "19:channel@thread.tacv2" })).toBe("channel");
    expect(infer?.({ to: "19:group@thread.v2" })).toBe("group");
    expect(
      msteamsPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {},
        agentId: "main",
        target: ownerId,
      }),
    ).toMatchObject({ chatType: "direct" });
  });

  it("shares setup and directory contracts with the lightweight artifacts", () => {
    expect(msteamsSetupPlugin.meta).toEqual(msteamsPlugin.meta);
    expect(msteamsPlugin.capabilities).toBe(msteamsSetupPlugin.capabilities);
    expect(msteamsPlugin.reload).toBe(msteamsSetupPlugin.reload);
    expect(msteamsPlugin.configSchema).toBe(msteamsSetupPlugin.configSchema);

    for (const key of [
      "listAccountIds",
      "resolveAccount",
      "defaultAccountId",
      "setAccountEnabled",
      "deleteAccount",
      "resolveAllowFrom",
      "formatAllowFrom",
      "resolveDefaultTo",
    ] as const) {
      expect(msteamsSetupPlugin.config[key]).toBe(msteamsPlugin.config[key]);
    }

    expect(msteamsPlugin.directory?.self).toBe(msteamsDirectoryContractPlugin.directory.self);
    expect(msteamsPlugin.directory?.listPeers).toBe(
      msteamsDirectoryContractPlugin.directory.listPeers,
    );
    expect(msteamsPlugin.directory?.listGroups).toBe(
      msteamsDirectoryContractPlugin.directory.listGroups,
    );
  });

  it("declares its implemented group and reaction capabilities", () => {
    expect(msteamsSetupPlugin.capabilities.chatTypes).toContain("group");
    expect(msteamsSetupPlugin.capabilities.reactions).toBe(true);
  });

  it("preserves the default account and allowlist across runtime and setup", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          ...createConfiguredMSTeamsCfg().channels?.msteams,
          allowFrom: ["OWNER", "  Team.Member  "],
          defaultTo: "19:team@thread.tacv2",
        },
      },
    };

    for (const plugin of [msteamsPlugin, msteamsSetupPlugin]) {
      expect(plugin.config.defaultAccountId?.(cfg)).toBe("default");
      expect(plugin.config.resolveAccount(cfg, "ignored")).toEqual({
        accountId: "default",
        enabled: true,
        configured: true,
        config: {},
        tokenStatus: "available",
      });
      expect(plugin.config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
        "OWNER",
        "  Team.Member  ",
      ]);
      expect(
        plugin.config.formatAllowFrom?.({
          cfg,
          accountId: "default",
          allowFrom: ["OWNER", "  Team.Member  "],
        }),
      ).toEqual(["owner", "team.member"]);
      expect(plugin.config.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe(
        "19:team@thread.tacv2",
      );
    }
  });

  it.each([
    {
      label: "configured certificate",
      configuredPath: "/private/msteams-unavailable-configured.pem",
      envPath: undefined,
      diagnosticPath: "channels.msteams.certificatePath",
    },
    {
      label: "environment certificate",
      configuredPath: "   ",
      envPath: "/private/msteams-unavailable-env.pem",
      diagnosticPath: "env.MSTEAMS_CERTIFICATE_PATH",
    },
  ])("degrades an unavailable $label without exposing its filesystem path", async (selection) => {
    if (selection.envPath) {
      vi.stubEnv("MSTEAMS_CERTIFICATE_PATH", selection.envPath);
    }
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          appId: "app-id",
          tenantId: "tenant-id",
          authType: "federated",
          certificatePath: selection.configuredPath,
        },
      },
    };

    for (const plugin of [msteamsPlugin, msteamsSetupPlugin]) {
      const account = plugin.config.resolveAccount(cfg, "default");
      expect(account).toMatchObject({
        configured: true,
        tokenStatus: "configured_unavailable",
        credentialDiagnostics: [
          {
            code: "CREDENTIAL_FILE_UNAVAILABLE",
            path: selection.diagnosticPath,
            reason: "not-found",
          },
        ],
      });
      expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(
        selection.envPath ?? selection.configuredPath,
      );
      expect(plugin.config.isConfigured?.(account, cfg)).toBe(true);
      expect(plugin.config.describeAccount?.(account, cfg)).toMatchObject({
        configured: true,
        tokenStatus: "configured_unavailable",
      });
    }

    const account = msteamsPlugin.config.resolveAccount(cfg, "default");
    expect(await msteamsPlugin.status?.buildAccountSnapshot?.({ account, cfg })).toMatchObject({
      configured: true,
      tokenStatus: "configured_unavailable",
    });
  });

  it("does not fall back from a selected unavailable configured certificate to an env file", async () => {
    await withTempDir("msteams-certificate-precedence-", async (tempDir) => {
      const envCertificate = path.join(tempDir, "env-cert.pem");
      fs.writeFileSync(envCertificate, "available-certificate", "utf8");
      vi.stubEnv("MSTEAMS_CERTIFICATE_PATH", envCertificate);
      const cfg: OpenClawConfig = {
        channels: {
          msteams: {
            appId: "app-id",
            tenantId: "tenant-id",
            authType: "federated",
            certificatePath: "/private/msteams-selected-missing.pem",
          },
        },
      };

      expect(msteamsPlugin.config.resolveAccount(cfg, "default")).toMatchObject({
        configured: true,
        tokenStatus: "configured_unavailable",
        credentialDiagnostics: [
          { code: "CREDENTIAL_FILE_UNAVAILABLE", path: "channels.msteams.certificatePath" },
        ],
      });
    });
  });

  it("does not inspect an unavailable certificate when managed identity is selected", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          appId: "app-id",
          tenantId: "tenant-id",
          authType: "federated",
          certificatePath: "/private/msteams-unused-missing-certificate.pem",
          useManagedIdentity: true,
        },
      },
    };

    expect(msteamsPlugin.config.resolveAccount(cfg, "default")).toEqual({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {},
      tokenStatus: "available",
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves the existing symlink-friendly certificate file policy",
    async () => {
      await withTempDir("msteams-certificate-symlink-", async (tempDir) => {
        const certificate = path.join(tempDir, "certificate.pem");
        const symlink = path.join(tempDir, "certificate-link.pem");
        fs.writeFileSync(certificate, "available-certificate", "utf8");
        fs.symlinkSync(certificate, symlink);
        const cfg: OpenClawConfig = {
          channels: {
            msteams: {
              appId: "app-id",
              tenantId: "tenant-id",
              authType: "federated",
              certificatePath: symlink,
            },
          },
        };

        expect(msteamsPlugin.config.resolveAccount(cfg, "default")).toMatchObject({
          configured: true,
          tokenStatus: "available",
        });
      });
    },
  );

  it("exposes native approval delivery without replacing existing approval authorization", () => {
    const authorization = {
      cfg: createConfiguredMSTeamsCfg(),
      senderId: "40a1a0ed-4ff2-4164-a219-55518990c197",
      action: "approve",
      approvalKind: "exec",
    } as const;

    expect(msteamsPlugin.approvalCapability).toBe(msTeamsApprovalCapability);
    expect(msteamsPlugin.approvalCapability?.authorizeActorAction?.(authorization)).toEqual(
      msTeamsApprovalAuth.authorizeActorAction?.(authorization),
    );
    expect(msteamsPlugin.approvalCapability?.nativeRuntime?.eventKinds).toEqual([
      "exec",
      "plugin",
      "system-agent",
    ]);
  });

  it("exposes the configured DM policy to security audits", () => {
    const cfg = {
      channels: {
        msteams: {
          ...createConfiguredMSTeamsCfg().channels?.msteams,
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;
    for (const plugin of [msteamsPlugin, msteamsSetupPlugin]) {
      const resolveDmPolicy = plugin.security?.resolveDmPolicy;
      if (!resolveDmPolicy) {
        throw new Error("msteams security.resolveDmPolicy unavailable");
      }

      const result = resolveDmPolicy({
        cfg,
        account: plugin.config.resolveAccount(cfg, "default"),
      });

      expect(result).toMatchObject({
        policy: "open",
        allowFrom: ["*"],
        policyPath: "channels.msteams.dmPolicy",
        allowFromPath: "channels.msteams.",
      });
      expect(result?.normalizeEntry?.(" 0123456789ABCDEF ")).toBe("0123456789abcdef");
      expect(result?.normalizeEntry?.(" msteams:user:0123456789ABCDEF ")).toBe("0123456789abcdef");
      expect(result?.normalizeEntry?.(" teams:0123456789ABCDEF ")).toBe("0123456789abcdef");
    }
    expect(msteamsSetupPlugin.security?.resolveDmPolicy).toBe(
      msteamsPlugin.security?.resolveDmPolicy,
    );
  });

  it("keeps critical open-group findings on the setup security surface", async () => {
    const cfg = {
      channels: {
        msteams: {
          ...createConfiguredMSTeamsCfg().channels?.msteams,
          groupPolicy: "open",
        },
      },
    } as OpenClawConfig;

    for (const plugin of [msteamsPlugin, msteamsSetupPlugin]) {
      const collectWarnings = plugin.security?.collectWarnings;
      if (!collectWarnings) {
        throw new Error("msteams security.collectWarnings unavailable");
      }

      const warnings = await collectWarnings({
        cfg,
        accountId: "default",
        account: plugin.config.resolveAccount(cfg, "default"),
      });
      expect(warnings).toEqual([
        expect.objectContaining({
          checkId: "channels.msteams.groups.open",
          severity: "critical",
        }),
      ]);
    }
    expect(msteamsSetupPlugin.security?.collectWarnings).toBe(
      msteamsPlugin.security?.collectWarnings,
    );
  });

  it("classifies authored Teams identities for security audits", () => {
    const stableId = "40a1a0ed-4ff2-4164-a219-55518990c197";
    const stableNonUuidId = "0123456789abcdef";
    const cfg = {
      channels: {
        msteams: {
          ...createConfiguredMSTeamsCfg().channels?.msteams,
          dmPolicy: "allowlist",
          allowFrom: [stableId, stableNonUuidId, "Alice Example", "alice@example.com"],
          dangerouslyAllowNameMatching: true,
        },
      },
    } as OpenClawConfig;

    for (const plugin of [msteamsPlugin, msteamsSetupPlugin]) {
      const account = plugin.config.resolveAccount(cfg, "default");
      const policy = plugin.security?.resolveDmPolicy?.({ cfg, account });
      const classify = policy?.classifyEntryAuthentication;
      if (!classify) {
        throw new Error("msteams DM entry classifier unavailable");
      }

      expect(account.config).toEqual({ dangerouslyAllowNameMatching: true });
      expect(classify(stableId)).toBe("asserted");
      expect(classify(`teams:user:${stableId}`)).toBe("asserted");
      expect(classify(stableNonUuidId)).toBe("asserted");
      expect(classify(`msteams:user:${stableNonUuidId}`)).toBe("asserted");
      expect(classify("Alice Example")).toBe("mutable");
      expect(classify("alice@example.com")).toBe("mutable");
      expect(classify("19:group@thread.tacv2")).toBeUndefined();
      expect(classify(`conversation:${stableNonUuidId}`)).toBe("asserted");
      expect(classify(`msteams:conversation:${stableNonUuidId}`)).toBe("asserted");
      expect(classify(` teams:conversation:${stableId.toUpperCase()} `)).toBe("asserted");
      expect(classify("conversation:Alice Example")).toBeUndefined();
      expect(classify("msteams:conversation:alice@example.com")).toBeUndefined();
      expect(classify("teams:conversation:19:group@thread.tacv2")).toBeUndefined();
    }
  });

  it("advertises legacy and group-management message-tool actions together", () => {
    const actions = msteamsPlugin.actions?.describeMessageTool?.({
      cfg: createConfiguredMSTeamsCfg(),
    })?.actions;

    expect(actions).toEqual([
      "upload-file",
      "poll",
      "edit",
      "delete",
      "pin",
      "unpin",
      "list-pins",
      "read",
      "react",
      "reactions",
      "search",
      "member-info",
      "channel-list",
      "channel-info",
      "addParticipant",
      "removeParticipant",
      "renameGroup",
    ]);
  });

  it("registers the approval runtime before monitor startup only when native delivery is enabled", async () => {
    const monitorModule = await import("./index.js");
    const monitor = vi.spyOn(monitorModule, "monitorMSTeamsProvider").mockResolvedValue({
      app: null,
      shutdown: async () => {},
    });
    const register = vi.fn(() => ({ dispose: vi.fn() }));
    const controller = new AbortController();
    const cfg: OpenClawConfig = {
      ...createConfiguredMSTeamsCfg(),
      approvals: { exec: { enabled: true } },
      channels: {
        msteams: {
          ...createConfiguredMSTeamsCfg().channels?.msteams,
          allowFrom: ["40a1a0ed-4ff2-4164-a219-55518990c197"],
        },
      },
    };
    const startAccount = async (config: OpenClawConfig) =>
      await msteamsPlugin.gateway?.startAccount?.({
        cfg: config,
        accountId: "default",
        account: msteamsPlugin.config.resolveAccount(config, "default"),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        abortSignal: controller.signal,
        getStatus: () => ({ accountId: "default" }),
        setStatus: vi.fn(),
        channelRuntime: {
          runtimeContexts: {
            register,
            get: () => undefined,
            watch: () => () => {},
          },
        },
      });

    try {
      await startAccount(cfg);

      expect(register).toHaveBeenCalledWith({
        channelId: "msteams",
        accountId: "default",
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: {},
        abortSignal: controller.signal,
      });
      expect(register.mock.invocationCallOrder[0]).toBeLessThan(
        monitor.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );

      await startAccount({ ...cfg, approvals: { exec: { enabled: false } } });

      expect(register).toHaveBeenCalledOnce();
      expect(monitor).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      monitor.mockRestore();
    }
  });

  it("reuses the shared Teams target-id matcher for explicit targets", () => {
    const looksLikeId = msteamsPlugin.messaging?.targetResolver?.looksLikeId;

    expect(looksLikeId?.("29:1a2b3c4d5e6f")).toBe(true);
    expect(looksLikeId?.("a:1bfPersonalChat")).toBe(true);
    expect(looksLikeId?.("user:Jane Doe")).toBe(false);
  });

  it("recognizes provider-prefixed explicit targets without claiming display names", () => {
    const messaging = msteamsPlugin.messaging;
    const aadUserId = "40a1a0ed-4ff2-4164-a219-55518990c197";

    expect(
      ["teams", "msteams"].map((provider) => {
        const target = `${provider}:user:${aadUserId}`;
        return {
          explicit: messaging?.targetResolver?.looksLikeId?.(target),
          normalized: messaging?.normalizeTarget?.(target),
        };
      }),
    ).toEqual([
      { explicit: true, normalized: `user:${aadUserId}` },
      { explicit: true, normalized: `user:${aadUserId}` },
    ]);
    expect(messaging?.targetResolver?.looksLikeId?.("teams:user:Jane Doe")).toBe(false);
    expect(messaging?.targetResolver?.looksLikeId?.("msteams:user:Jane Doe")).toBe(false);
  });
});

describe("msteams config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    const res = MSTeamsConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts historyLimit", () => {
    const res = MSTeamsConfigSchema.safeParse({ historyLimit: 4 });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(4);
    }
  });

  it("accepts the opt-in Graph media fallback", () => {
    const res = MSTeamsConfigSchema.safeParse({ graphMediaFallback: true });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.graphMediaFallback).toBe(true);
    }
  });

  it("accepts replyStyle at global/team/channel levels", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "top-level",
      teams: {
        team123: {
          replyStyle: "thread",
          channels: {
            chan456: { replyStyle: "top-level" },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.replyStyle).toBe("top-level");
      expect(res.data.teams?.team123?.replyStyle).toBe("thread");
      expect(res.data.teams?.team123?.channels?.chan456?.replyStyle).toBe("top-level");
    }
  });

  it("accepts Teams SDK cloud and serviceUrl configuration", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGovDoD",
      serviceUrl: "https://smba.infra.dod.teams.microsoft.us/teams",
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.cloud).toBe("USGovDoD");
      expect(res.data.serviceUrl).toBe("https://smba.infra.dod.teams.microsoft.us/teams");
    }
  });

  it("rejects unsupported Teams serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGovDoD",
      serviceUrl: "https://dod.example.mil/teams",
    });

    expect(res.success).toBe(false);
  });

  it("accepts China cloud without a configured global serviceUrl", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
    });

    expect(res.success).toBe(true);
  });

  it("accepts Azure China Bot Framework serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
      serviceUrl: "https://msteams.botframework.azure.cn/teams",
    });

    expect(res.success).toBe(true);
  });

  it("rejects non-China serviceUrl hosts when China cloud is configured", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
      serviceUrl: "https://smba.trafficmanager.net/teams",
    });

    expect(res.success).toBe(false);
  });

  it("rejects Azure China Bot Framework serviceUrl hosts without China cloud", () => {
    const res = MSTeamsConfigSchema.safeParse({
      serviceUrl: "https://msteams.botframework.azure.cn/teams",
    });

    expect(res.success).toBe(false);
  });

  it("requires serviceUrl with non-public Teams clouds", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGov",
    });

    expect(res.success).toBe(false);
  });

  it("rejects invalid replyStyle", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "nope",
    });

    expect(res.success).toBe(false);
  });
});

describe("msTeamsApprovalAuth", () => {
  const ownerId = "123e4567-e89b-12d3-a456-426614174000";
  const otherUserId = "22222222-2222-4222-8222-222222222222";

  function authorizeApproval(allowFrom: string[], senderId: string) {
    return msTeamsApprovalAuth.authorizeActorAction({
      cfg: { channels: { msteams: { allowFrom } } },
      senderId,
      action: "approve",
      approvalKind: "exec",
    });
  }

  it.each([
    ["bare", ownerId],
    ["user-prefixed", `user:${ownerId}`],
    ["provider-prefixed", `msteams:user:${ownerId}`],
    ["provider-prefixed bare", `teams:${ownerId}`],
    ["uppercase", `MSTEAMS:USER:${ownerId.toUpperCase()}`],
  ])("authorizes only the configured owner for %s AAD object IDs", (_label, allowFrom) => {
    expect(authorizeApproval([allowFrom], ownerId)).toEqual({ authorized: true });
    expect(authorizeApproval([allowFrom], otherUserId)).toMatchObject({ authorized: false });
  });

  it.each([
    ["conversation", `conversation:${otherUserId}`],
    ["provider-prefixed conversation", `msteams:conversation:${otherUserId}`],
    ["whitespace-padded provider conversation", ` msteams:conversation:${otherUserId} `],
    ["chat", `chat:${otherUserId}`],
    ["email", "owner@example.com"],
    ["display name", "Owner Display"],
    ["access group", "accessGroup:operators"],
    ["wildcard", "*"],
    ["braced UUID", `{${otherUserId}}`],
  ])("does not treat %s entries as stable approval principals", (_label, invalidPrincipal) => {
    expect(authorizeApproval([ownerId, invalidPrincipal], otherUserId)).toMatchObject({
      authorized: false,
    });
  });

  it("preserves implicit same-chat fallback for display-name-only allowlists", () => {
    expect(authorizeApproval(["Owner Display"], "attacker-aad")).toEqual({ authorized: true });
  });
});
