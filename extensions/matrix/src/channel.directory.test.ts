import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import { matrixPlugin } from "./channel.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { resolveMatrixConfigForAccount } from "./matrix/client/config.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

function requireMatrixDirectory() {
  const directory = matrixPlugin.directory;
  if (!directory?.listPeers || !directory.listGroups) {
    throw new Error("expected Matrix directory listPeers/listGroups");
  }
  return {
    listPeers: directory.listPeers,
    listGroups: directory.listGroups,
  };
}

function requireMatrixReplyToModeResolver() {
  const resolveReplyToMode = matrixPlugin.threading?.resolveReplyToMode;
  if (!resolveReplyToMode) {
    throw new Error("expected Matrix replyToMode resolver");
  }
  return resolveReplyToMode;
}

function requireDirectoryEntry(
  entries: readonly { kind: string; id: string; name?: string }[],
  kind: string,
  id: string,
) {
  const entry = entries.find((candidate) => candidate.kind === kind && candidate.id === id);
  if (!entry) {
    throw new Error(`expected Matrix directory entry ${kind}:${id}`);
  }
  return entry;
}

describe("matrix directory", () => {
  const runtimeEnv: RuntimeEnv = createRuntimeEnv();

  beforeEach(() => {
    installMatrixTestRuntime();
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["matrix:@alice:example.org", "bob"] },
          groupAllowFrom: ["@dana:example.org"],
          groups: {
            "!room1:example.org": { users: ["@carol:example.org"] },
            "#alias:example.org": { users: [] },
          },
        },
      },
    } as unknown as CoreConfig;

    const directory = requireMatrixDirectory();

    const peers = await directory.listPeers({
      cfg,
      accountId: undefined,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(requireDirectoryEntry(peers, "user", "user:@alice:example.org").name).toBeUndefined();
    expect(requireDirectoryEntry(peers, "user", "bob").name).toBe(
      "incomplete id; expected @user:server",
    );
    expect(requireDirectoryEntry(peers, "user", "user:@carol:example.org").name).toBeUndefined();
    expect(requireDirectoryEntry(peers, "user", "user:@dana:example.org").name).toBeUndefined();

    const groups = await directory.listGroups({
      cfg,
      accountId: undefined,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(requireDirectoryEntry(groups, "group", "room:!room1:example.org").name).toBeUndefined();
    expect(requireDirectoryEntry(groups, "group", "#alias:example.org").name).toBeUndefined();
  });

  it("resolves replyToMode from account config", () => {
    const cfg = {
      channels: {
        matrix: {
          replyToMode: "off",
          accounts: {
            Assistant: {
              replyToMode: "all",
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const resolveReplyToMode = requireMatrixReplyToModeResolver();
    expect(
      resolveReplyToMode({
        cfg,
        accountId: "assistant",
        chatType: "direct",
      }),
    ).toBe("all");
    expect(
      resolveReplyToMode({
        cfg,
        accountId: "default",
        chatType: "direct",
      }),
    ).toBe("off");
  });

  it("only exposes real Matrix thread ids in tool context", () => {
    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: {
          To: "room:!room:example.org",
          ReplyToId: "$reply",
        },
        hasRepliedRef: { value: false },
      }),
    ).toEqual({
      currentChannelId: "room:!room:example.org",
      currentThreadTs: undefined,
      hasRepliedRef: { value: false },
    });

    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: {
          To: "room:!room:example.org",
          ReplyToId: "$reply",
          MessageThreadId: "$thread",
        },
        hasRepliedRef: { value: true },
      }),
    ).toEqual({
      currentChannelId: "room:!room:example.org",
      currentThreadTs: "$thread",
      hasRepliedRef: { value: true },
    });
  });

  it("exposes Matrix direct user id in dm tool context", () => {
    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: {
          From: "matrix:@alice:example.org",
          To: "room:!dm:example.org",
          ChatType: "direct",
          MessageThreadId: "$thread",
        },
        hasRepliedRef: { value: false },
      }),
    ).toEqual({
      currentChannelId: "room:!dm:example.org",
      currentThreadTs: "$thread",
      currentDirectUserId: "@alice:example.org",
      hasRepliedRef: { value: false },
    });
  });

  it("accepts raw room ids when inferring Matrix direct user ids", () => {
    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: {
          From: "user:@alice:example.org",
          To: "!dm:example.org",
          ChatType: "direct",
        },
        hasRepliedRef: { value: false },
      }),
    ).toEqual({
      currentChannelId: "!dm:example.org",
      currentThreadTs: undefined,
      currentDirectUserId: "@alice:example.org",
      hasRepliedRef: { value: false },
    });
  });

  it("resolves group mention policy from account config", () => {
    const cfg = {
      channels: {
        matrix: {
          groups: {
            "!room:example.org": { requireMention: true },
          },
          accounts: {
            Assistant: {
              groups: {
                "!room:example.org": { requireMention: false },
              },
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.groups!.resolveRequireMention!({ cfg, groupId: "!room:example.org" })).toBe(
      true,
    );
    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        cfg,
        accountId: "assistant",
        groupId: "!room:example.org",
      }),
    ).toBe(false);

    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        cfg,
        accountId: "assistant",
        groupId: "matrix:room:!room:example.org",
      }),
    ).toBe(false);
  });

  it("matches prefixed Matrix aliases in group context", () => {
    const cfg = {
      channels: {
        matrix: {
          groups: {
            "#ops:example.org": { requireMention: false },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        cfg,
        groupId: "matrix:room:!room:example.org",
        groupChannel: "matrix:channel:#ops:example.org",
      }),
    ).toBe(false);
  });

  it("reports room access warnings against the active Matrix config path", () => {
    expect(
      matrixPlugin.security?.collectWarnings?.({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "open",
            },
          },
        } as CoreConfig,
        account: resolveMatrixAccount({
          cfg: {
            channels: {
              matrix: {
                groupPolicy: "open",
              },
            },
          } as CoreConfig,
          accountId: "default",
        }),
      }),
    ).toEqual([
      '- Matrix rooms: groupPolicy="open" allows any room to trigger (mention-gated). Set channels.matrix.groupPolicy="allowlist" + channels.matrix.groups (and optionally channels.matrix.groupAllowFrom) to restrict rooms.',
    ]);

    expect(
      matrixPlugin.security?.collectWarnings?.({
        cfg: {
          channels: {
            matrix: {
              defaultAccount: "assistant",
              accounts: {
                assistant: {
                  groupPolicy: "open",
                },
              },
            },
          },
        } as CoreConfig,
        account: resolveMatrixAccount({
          cfg: {
            channels: {
              matrix: {
                defaultAccount: "assistant",
                accounts: {
                  assistant: {
                    groupPolicy: "open",
                  },
                },
              },
            },
          } as CoreConfig,
          accountId: "assistant",
        }),
      }),
    ).toEqual([
      '- Matrix rooms: groupPolicy="open" allows any room to trigger (mention-gated). Set channels.matrix.accounts.assistant.groupPolicy="allowlist" + channels.matrix.accounts.assistant.groups (and optionally channels.matrix.accounts.assistant.groupAllowFrom) to restrict rooms.',
    ]);
  });

  it("reports invite auto-join warnings only when explicitly enabled", () => {
    expect(
      matrixPlugin.security?.collectWarnings?.({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "allowlist",
              autoJoin: "always",
            },
          },
        } as CoreConfig,
        account: resolveMatrixAccount({
          cfg: {
            channels: {
              matrix: {
                groupPolicy: "allowlist",
                autoJoin: "always",
              },
            },
          } as CoreConfig,
          accountId: "default",
        }),
      }),
    ).toEqual([
      '- Matrix invites: autoJoin="always" joins any invited room before message policy applies. Set channels.matrix.autoJoin="allowlist" + channels.matrix.autoJoinAllowlist (or channels.matrix.autoJoin="off") to restrict joins.',
    ]);
  });

  it("writes matrix non-default account credentials under channels.matrix.accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://default.example.org",
          accessToken: "default-token",
          deviceId: "DEFAULTDEVICE",
          avatarUrl: "mxc://server/avatar",
          encryption: true,
          threadReplies: "inbound",
          groups: {
            "!room:example.org": { requireMention: true },
          },
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "ops",
      input: {
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix"]?.accessToken).toBeUndefined();
    expect(updated.channels?.["matrix"]?.deviceId).toBeUndefined();
    expect(updated.channels?.["matrix"]?.avatarUrl).toBeUndefined();
    const defaultAccount = updated.channels?.["matrix"]?.accounts?.default;
    expect(defaultAccount?.accessToken).toBe("default-token");
    expect(defaultAccount?.homeserver).toBe("https://default.example.org");
    expect(defaultAccount?.deviceId).toBe("DEFAULTDEVICE");
    expect(defaultAccount?.avatarUrl).toBe("mxc://server/avatar");
    expect(defaultAccount?.encryption).toBe(true);
    expect(defaultAccount?.threadReplies).toBe("inbound");
    expect(defaultAccount?.groups).toEqual({
      "!room:example.org": { requireMention: true },
    });
    const opsAccount = updated.channels?.["matrix"]?.accounts?.ops;
    expect(opsAccount?.enabled).toBe(true);
    expect(opsAccount?.homeserver).toBe("https://matrix.example.org");
    expect(opsAccount?.userId).toBe("@ops:example.org");
    expect(opsAccount?.accessToken).toBe("ops-token");
    const resolvedOps = resolveMatrixConfigForAccount(updated, "ops", {});
    expect(resolvedOps.homeserver).toBe("https://matrix.example.org");
    expect(resolvedOps.userId).toBe("@ops:example.org");
    expect(resolvedOps.accessToken).toBe("ops-token");
    expect(resolvedOps.deviceId).toBeUndefined();
  });

  it("writes default matrix account credentials under channels.matrix.accounts.default", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://legacy.example.org",
          accessToken: "legacy-token",
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "bot-token",
      },
    }) as CoreConfig;

    const matrixConfig = updated.channels?.["matrix"];
    expect(matrixConfig?.enabled).toBe(true);
    expect(matrixConfig?.homeserver).toBe("https://matrix.example.org");
    expect(matrixConfig?.userId).toBe("@bot:example.org");
    expect(matrixConfig?.accessToken).toBe("bot-token");
    expect(updated.channels?.["matrix"]?.accounts).toBeUndefined();
  });

  it("requires account-scoped env vars when --use-env is set for non-default accounts", () => {
    const envKeys = [
      "MATRIX_OPS_HOMESERVER",
      "MATRIX_OPS_USER_ID",
      "MATRIX_OPS_ACCESS_TOKEN",
      "MATRIX_OPS_PASSWORD",
    ] as const;
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    for (const key of envKeys) {
      delete process.env[key];
    }
    try {
      const error = matrixPlugin.setup!.validateInput?.({
        cfg: {} as CoreConfig,
        accountId: "ops",
        input: { useEnv: true },
      });
      expect(error).toBe(
        'Set per-account env vars for "ops" (for example MATRIX_OPS_HOMESERVER + MATRIX_OPS_ACCESS_TOKEN or MATRIX_OPS_USER_ID + MATRIX_OPS_PASSWORD).',
      );
    } finally {
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previousEnv[key];
        }
      }
    }
  });

  it("accepts --use-env for non-default account when scoped env vars are present", () => {
    const envKeys = {
      MATRIX_OPS_HOMESERVER: process.env.MATRIX_OPS_HOMESERVER,
      MATRIX_OPS_ACCESS_TOKEN: process.env.MATRIX_OPS_ACCESS_TOKEN,
    };
    process.env.MATRIX_OPS_HOMESERVER = "https://ops.example.org";
    process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-token";
    try {
      const error = matrixPlugin.setup!.validateInput?.({
        cfg: {} as CoreConfig,
        accountId: "ops",
        input: { useEnv: true },
      });
      expect(error).toBeNull();
    } finally {
      for (const [key, value] of Object.entries(envKeys)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("clears stored auth fields when switching a Matrix account to env-backed auth", () => {
    const envKeys = {
      MATRIX_OPS_HOMESERVER: process.env.MATRIX_OPS_HOMESERVER,
      MATRIX_OPS_ACCESS_TOKEN: process.env.MATRIX_OPS_ACCESS_TOKEN,
      MATRIX_OPS_DEVICE_ID: process.env.MATRIX_OPS_DEVICE_ID,
      MATRIX_OPS_DEVICE_NAME: process.env.MATRIX_OPS_DEVICE_NAME,
    };
    process.env.MATRIX_OPS_HOMESERVER = "https://ops.env.example.org";
    process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-env-token";
    process.env.MATRIX_OPS_DEVICE_ID = "OPSENVDEVICE";
    process.env.MATRIX_OPS_DEVICE_NAME = "Ops Env Device";

    try {
      const cfg = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                homeserver: "https://ops.inline.example.org",
                userId: "@ops:inline.example.org",
                accessToken: "ops-inline-token",
                password: "ops-inline-password", // pragma: allowlist secret
                deviceId: "OPSINLINEDEVICE",
                deviceName: "Ops Inline Device",
                encryption: true,
              },
            },
          },
        },
      } as unknown as CoreConfig;

      const updated = matrixPlugin.setup!.applyAccountConfig({
        cfg,
        accountId: "ops",
        input: {
          useEnv: true,
          name: "Ops",
        },
      }) as CoreConfig;

      const opsAccount = updated.channels?.["matrix"]?.accounts?.ops;
      expect(opsAccount?.name).toBe("Ops");
      expect(opsAccount?.enabled).toBe(true);
      expect(opsAccount?.encryption).toBe(true);
      expect(opsAccount?.homeserver).toBeUndefined();
      expect(opsAccount?.userId).toBeUndefined();
      expect(opsAccount?.accessToken).toBeUndefined();
      expect(opsAccount?.password).toBeUndefined();
      expect(opsAccount?.deviceId).toBeUndefined();
      expect(opsAccount?.deviceName).toBeUndefined();
      const resolvedOps = resolveMatrixConfigForAccount(updated, "ops", process.env);
      expect(resolvedOps.homeserver).toBe("https://ops.env.example.org");
      expect(resolvedOps.accessToken).toBe("ops-env-token");
      expect(resolvedOps.deviceId).toBe("OPSENVDEVICE");
      expect(resolvedOps.deviceName).toBe("Ops Env Device");
    } finally {
      for (const [key, value] of Object.entries(envKeys)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("resolves account id from input name when explicit account id is missing", () => {
    const accountId = matrixPlugin.setup!.resolveAccountId?.({
      cfg: {} as CoreConfig,
      accountId: undefined,
      input: { name: "Main Bot" },
    });
    expect(accountId).toBe("main-bot");
  });

  it("resolves binding account id from agent id when omitted", () => {
    const accountId = matrixPlugin.setup!.resolveBindingAccountId?.({
      cfg: {} as CoreConfig,
      agentId: "Ops",
      accountId: undefined,
    });
    expect(accountId).toBe("ops");
  });

  it("clears stale access token when switching an account to password auth", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              accessToken: "old-token",
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        password: "new-password", // pragma: allowlist secret
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix"]?.accounts?.default?.password).toBe("new-password");
    expect(updated.channels?.["matrix"]?.accounts?.default?.accessToken).toBeUndefined();
  });

  it("clears stale password when switching an account to token auth", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              password: "old-password", // pragma: allowlist secret
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {
        homeserver: "https://matrix.example.org",
        accessToken: "new-token",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix"]?.accounts?.default?.accessToken).toBe("new-token");
    expect(updated.channels?.["matrix"]?.accounts?.default?.password).toBeUndefined();
  });
});
