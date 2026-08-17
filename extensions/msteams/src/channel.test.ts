// Msteams tests cover channel plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { msteamsDirectoryContractPlugin } from "../directory-contract-api.js";
import {
  listMSTeamsAccountIds,
  resolveMSTeamsAccount,
  resolveMSTeamsAccountConfig,
} from "./accounts.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import { createMSTeamsSecurityWarningCollector } from "./channel-security.js";
import { msteamsPlugin } from "./channel.js";
import { msteamsSetupPlugin } from "./channel.setup.js";

const probeMSTeamsMock = vi.hoisted(() => vi.fn());

vi.mock("./channel.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channel.runtime.js")>();
  return {
    msTeamsChannelRuntime: {
      ...actual.msTeamsChannelRuntime,
      probeMSTeams: probeMSTeamsMock,
    },
  };
});

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
  afterEach(() => {
    probeMSTeamsMock.mockReset();
  });

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

  it("exposes approval auth through approvalCapability", () => {
    expect(msteamsPlugin.approvalCapability).toBe(msTeamsApprovalAuth);
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

  it("uses account-scoped Teams credentials for message-tool discovery", () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      msteamsPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "default",
      })?.actions,
    ).toEqual([]);
    expect(
      msteamsPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "support",
      })?.actions,
    ).toContain("upload-file");
  });

  it("probes the resolved named account config", async () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;
    const account = msteamsPlugin.config.resolveAccount(cfg, "support");
    probeMSTeamsMock.mockResolvedValueOnce({ ok: true, appId: "support-app-id" });

    await msteamsPlugin.status?.probeAccount?.({ cfg, account, timeoutMs: 1_000 });

    expect(probeMSTeamsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "support-app-id",
        appPassword: "support-secret",
        tenantId: "tenant-id",
        webhook: { port: 3979 },
      }),
      { accountId: "support" },
    );
  });

  it("evaluates group-policy warnings for the requested account", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              tenantId: "tenant-id",
              groupPolicy: "open",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;
    const account = msteamsPlugin.config.resolveAccount(cfg, "support");

    const findings = await msteamsPlugin.security?.collectWarnings?.({
      cfg,
      accountId: "support",
      account,
    });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "channels.msteams.groups.open",
        severity: "critical",
        title: "MS Teams security warning",
        detail: expect.stringMatching(
          /MS Teams\[support\].*channels\.msteams\.accounts\.support\.groupPolicy.*channels\.msteams\.accounts\.support\.groupAllowFrom/,
        ),
      }),
    ]);
    expect(
      await msteamsPlugin.security?.collectWarnings?.({
        cfg,
        accountId: "default",
        account: msteamsPlugin.config.resolveAccount(cfg, "default"),
      }),
    ).toEqual([]);

    const legacyWarnings = createMSTeamsSecurityWarningCollector(undefined)({
      cfg,
      accountId: "support",
    });
    expect(legacyWarnings).toEqual([
      expect.stringMatching(
        /MS Teams\[support\].*channels\.msteams\.accounts\.support\.groupPolicy.*channels\.msteams\.accounts\.support\.groupAllowFrom/,
      ),
    ]);
  });

  it("does not advertise message tools for disabled or unconfigured named accounts", () => {
    const previousEnv = {
      appId: process.env.MSTEAMS_APP_ID,
      appPassword: process.env.MSTEAMS_APP_PASSWORD,
      tenantId: process.env.MSTEAMS_TENANT_ID,
    };
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_APP_PASSWORD = "env-secret";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    try {
      const cfg = {
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-id",
            accounts: {
              disabled: {
                enabled: false,
                appId: "disabled-app-id",
                appPassword: "disabled-secret",
                webhook: { port: 3979 },
              },
              unconfigured: {
                appId: "unconfigured-app-id",
                webhook: { port: 3980 },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(
        msteamsPlugin.actions?.describeMessageTool?.({
          cfg,
          accountId: "disabled",
        })?.actions,
      ).toEqual([]);
      expect(
        msteamsPlugin.actions?.describeMessageTool?.({
          cfg,
          accountId: "unconfigured",
        })?.actions,
      ).toEqual([]);
    } finally {
      if (previousEnv.appId === undefined) {
        delete process.env.MSTEAMS_APP_ID;
      } else {
        process.env.MSTEAMS_APP_ID = previousEnv.appId;
      }
      if (previousEnv.appPassword === undefined) {
        delete process.env.MSTEAMS_APP_PASSWORD;
      } else {
        process.env.MSTEAMS_APP_PASSWORD = previousEnv.appPassword;
      }
      if (previousEnv.tenantId === undefined) {
        delete process.env.MSTEAMS_TENANT_ID;
      } else {
        process.env.MSTEAMS_TENANT_ID = previousEnv.tenantId;
      }
    }
  });

  it("does not resolve legacy root credentials for arbitrary named accounts", () => {
    const cfg = createConfiguredMSTeamsCfg();
    const resolved = resolveMSTeamsAccountConfig(cfg, "typo-account");

    expect(resolved.appId).toBeUndefined();
    expect(resolved.appPassword).toBeUndefined();
    expect(resolved.tenantId).toBe("tenant-id");
    expect(resolveMSTeamsAccount({ cfg, accountId: "typo-account" })).toMatchObject({
      accountId: "typo-account",
      configured: false,
    });
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

describe("msteams account config", () => {
  it("lists root default and named accounts", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: { port: 3978 },
          accounts: {
            secondary: {
              appId: "secondary-app-id",
              appPassword: "secondary-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["default", "secondary"]);
  });

  it("resolves display-style account keys through their canonical account ids", () => {
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
          accounts: {
            "Support Bot": {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
          defaultAccount: "Support Bot",
        },
      },
    } as unknown as OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["support-bot"]);

    for (const accountId of ["Support Bot", "support-bot"]) {
      expect(resolveMSTeamsAccountConfig(cfg, accountId)).toMatchObject({
        appId: "support-app-id",
        appPassword: "support-secret",
        tenantId: "tenant-id",
        webhook: { port: 3979, path: "/api/messages" },
      });
      expect(resolveMSTeamsAccount({ cfg, accountId })).toMatchObject({
        accountId: "support-bot",
        configured: true,
        enabled: true,
      });
    }
  });

  it("keeps legacy root credentials as the implicit default account", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "legacy-app-id",
          appPassword: "legacy-secret",
          tenantId: "tenant-id",
          webhook: { port: 3978, path: "/api/messages" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["default"]);
    expect(resolveMSTeamsAccountConfig(cfg)).toMatchObject({
      appId: "legacy-app-id",
      appPassword: "legacy-secret",
      tenantId: "tenant-id",
      webhook: { port: 3978, path: "/api/messages" },
    });
    expect(resolveMSTeamsAccount({ cfg })).toMatchObject({
      accountId: "default",
      configured: true,
      enabled: true,
    });
  });

  it("inherits shared webhook path but not identity or port for named accounts", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: { port: 3978, path: "/api/messages" },
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            secondary: {
              appId: "secondary-app-id",
              appPassword: "secondary-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const secondary = resolveMSTeamsAccountConfig(cfg, "secondary");

    expect(secondary.appId).toBe("secondary-app-id");
    expect(secondary.appPassword).toBe("secondary-secret");
    expect(secondary.tenantId).toBe("tenant-id");
    expect(secondary.webhook).toEqual({ port: 3979, path: "/api/messages" });
    expect(secondary.allowFrom).toEqual(["*"]);
  });

  it("keeps identity when resolving an already account-scoped named account config", () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          defaultAccount: "secondary",
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          tenantId: "tenant-id",
          webhook: { port: 3979, path: "/api/messages" },
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } as unknown as OpenClawConfig;

    const secondary = resolveMSTeamsAccountConfig(cfg, "secondary");

    expect(secondary.appId).toBe("secondary-app-id");
    expect(secondary.appPassword).toBe("secondary-secret");
    expect(secondary.tenantId).toBe("tenant-id");
    expect(secondary.webhook).toEqual({ port: 3979, path: "/api/messages" });
    expect(resolveMSTeamsAccount({ cfg, accountId: "secondary" }).configured).toBe(true);
  });

  it("marks named accounts without explicit identity as unconfigured", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: { port: 3978, path: "/api/messages" },
          accounts: {
            secondary: {
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveMSTeamsAccount({ cfg, accountId: "secondary" }).configured).toBe(false);
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

  it("uses account-scoped approvers for named Teams accounts", () => {
    const rootApprover = "123e4567-e89b-12d3-a456-426614174000";
    const supportApprover = "223e4567-e89b-12d3-a456-426614174000";
    const cfg = {
      channels: {
        msteams: {
          allowFrom: [`user:${rootApprover}`],
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              allowFrom: [`user:${supportApprover}`],
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg,
        accountId: "support",
        senderId: supportApprover,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg,
        accountId: "support",
        senderId: rootApprover,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Microsoft Teams.",
    });
  });
});

describe("msteams directory contract", () => {
  it("uses account-scoped Teams config", async () => {
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          appId: "default-app-id",
          appPassword: "default-secret",
          allowFrom: ["user:default-user"],
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              allowFrom: ["user:support-user"],
              teams: {
                team1: {
                  channels: {
                    "19:support-channel": {},
                  },
                },
              },
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      msteamsDirectoryContractPlugin.directory.self?.({
        cfg,
        accountId: "support",
        runtime: {} as never,
      }),
    ).resolves.toEqual({ kind: "user", id: "support-app-id", name: "support-app-id" });
    await expect(
      msteamsDirectoryContractPlugin.directory.listPeers?.({
        cfg,
        accountId: "support",
        runtime: {} as never,
      }),
    ).resolves.toEqual([{ id: "user:support-user", kind: "user" }]);
    await expect(
      msteamsDirectoryContractPlugin.directory.listGroups?.({
        cfg,
        accountId: "support",
        runtime: {} as never,
      }),
    ).resolves.toEqual([{ id: "conversation:19:support-channel", kind: "group" }]);
  });

  it("does not use default env credentials for named directory accounts", async () => {
    const previousEnv = {
      appId: process.env.MSTEAMS_APP_ID,
      appPassword: process.env.MSTEAMS_APP_PASSWORD,
      tenantId: process.env.MSTEAMS_TENANT_ID,
    };
    process.env.MSTEAMS_APP_ID = "env-default-app";
    process.env.MSTEAMS_APP_PASSWORD = "env-default-secret";
    process.env.MSTEAMS_TENANT_ID = "env-default-tenant";
    try {
      const cfg = {
        channels: {
          msteams: {
            defaultAccount: "support",
            accounts: {
              support: {
                appId: "support-app-id",
                tenantId: "support-tenant-id",
                webhook: { port: 3979 },
              },
            },
          },
        },
      } as OpenClawConfig;

      await expect(
        msteamsDirectoryContractPlugin.directory.self?.({
          cfg,
          runtime: {} as never,
        }),
      ).resolves.toBeNull();
    } finally {
      if (previousEnv.appId === undefined) {
        delete process.env.MSTEAMS_APP_ID;
      } else {
        process.env.MSTEAMS_APP_ID = previousEnv.appId;
      }
      if (previousEnv.appPassword === undefined) {
        delete process.env.MSTEAMS_APP_PASSWORD;
      } else {
        process.env.MSTEAMS_APP_PASSWORD = previousEnv.appPassword;
      }
      if (previousEnv.tenantId === undefined) {
        delete process.env.MSTEAMS_TENANT_ID;
      } else {
        process.env.MSTEAMS_TENANT_ID = previousEnv.tenantId;
      }
    }
  });
});
