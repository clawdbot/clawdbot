import { describe, expect, it, vi } from "vitest";
import { widenOfficialExternalChannelSecretSchema } from "../../../config/official-external-channel-secret-schema.js";
import { validateJsonSchemaValue } from "../../../plugins/schema-validator.js";
import { LEGACY_CONFIG_MIGRATIONS_QQBOT } from "./legacy-config-migrations.qqbot.js";
import { maybeRepairOpenPolicyAllowFrom } from "./open-policy-allowfrom.js";

function migrate(raw: Record<string, unknown>) {
  const config = structuredClone(raw);
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_QQBOT) {
    migration.apply(config, changes);
  }
  return { config, changes };
}

describe("Tencent QQBot 2.0 config migrations", () => {
  it("creates a safe config shell for environment-only credentials", () => {
    vi.stubEnv("QQBOT_APP_ID", "environment-app");
    vi.stubEnv("QQBOT_CLIENT_SECRET", "placeholder");
    try {
      const result = migrate({});

      expect(result.config).toMatchObject({
        channels: {
          qqbot: {
            enabled: true,
            dmPolicy: "open",
            allowFrom: ["openclaw:approval-disabled"],
          },
        },
      });
      expect(JSON.stringify(result.config)).not.toContain("placeholder");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("converts root and account clientSecretFile values to file-backed SecretRefs", () => {
    const result = migrate({
      channels: {
        qqbot: {
          appId: "root-app",
          clientSecretFile: "/run/secrets/qqbot-root",
          accounts: {
            ops: {
              appId: "ops-app",
              clientSecretFile: "/run/secrets/qqbot-ops",
            },
          },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          clientSecret: {
            source: "file",
            provider: "qqbot-client-secret",
            id: "value",
          },
          accounts: {
            ops: {
              clientSecret: {
                source: "file",
                provider: "qqbot-ops-client-secret",
                id: "value",
              },
            },
          },
        },
      },
      secrets: {
        providers: {
          "qqbot-client-secret": {
            source: "file",
            path: "/run/secrets/qqbot-root",
            mode: "singleValue",
          },
          "qqbot-ops-client-secret": {
            source: "file",
            path: "/run/secrets/qqbot-ops",
            mode: "singleValue",
          },
        },
      },
    });
    expect(JSON.stringify(result.config)).not.toContain("clientSecretFile");
  });

  it("preserves an existing provider collision with a deterministic suffix", () => {
    const result = migrate({
      secrets: {
        providers: {
          "qqbot-client-secret": {
            source: "file",
            path: "/other/secret",
            mode: "singleValue",
          },
        },
      },
      channels: {
        qqbot: {
          clientSecretFile: "/run/secrets/qqbot",
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          clientSecret: {
            source: "file",
            provider: "qqbot-client-secret-2",
            id: "value",
          },
        },
      },
      secrets: {
        providers: {
          "qqbot-client-secret": { path: "/other/secret" },
          "qqbot-client-secret-2": { path: "/run/secrets/qqbot" },
        },
      },
    });
  });

  it("intersects explicit approval users with an existing restrictive chat allowlist", () => {
    const result = migrate({
      channels: {
        qqbot: {
          allowFrom: ["chat-admin", "shared-admin"],
          execApprovals: {
            approvers: ["approval-admin", "shared-admin"],
          },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["SHARED-ADMIN"],
        },
      },
    });
    expect(JSON.stringify(result.config)).not.toContain("execApprovals");
  });

  it("keeps an explicit empty DM allowlist restrictive when approvers were configured", () => {
    const result = migrate({
      channels: {
        qqbot: {
          dmPolicy: "allowlist",
          allowFrom: [],
          execApprovals: { approvers: ["admin"] },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          dmPolicy: "allowlist",
          allowFrom: ["openclaw:approval-disabled"],
        },
      },
    });
  });

  it("uses the legacy command operator override without promoting chat-only users", () => {
    const raw = {
      commands: { allowFrom: { qqbot: ["operator"] } },
      channels: {
        qqbot: {
          allowFrom: ["operator", "chat-only"],
        },
      },
    };
    const operatorRule = LEGACY_CONFIG_MIGRATIONS_QQBOT[0]?.legacyRules?.find((rule) =>
      rule.message.includes("commands.allowFrom approval operators"),
    );

    expect(operatorRule?.match?.(raw.channels.qqbot, raw)).toBe(true);

    const result = migrate(raw);

    expect(result.config).toMatchObject({
      channels: { qqbot: { allowFrom: ["OPERATOR"] } },
    });
    expect(
      operatorRule?.match?.((result.config.channels as { qqbot: unknown }).qqbot, result.config),
    ).toBe(false);
    expect(migrate(result.config).changes).toEqual([]);
  });

  it("locks approvals when command operators and restrictive chat access do not overlap", () => {
    const result = migrate({
      commands: { allowFrom: { "*": ["operator"] } },
      channels: {
        qqbot: {
          dmPolicy: "allowlist",
          allowFrom: ["chat-only"],
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          dmPolicy: "allowlist",
          allowFrom: ["openclaw:approval-disabled"],
        },
      },
    });
  });

  it("normalizes prefixed approvers before intersecting chat access", () => {
    const result = migrate({
      channels: {
        qqbot: {
          allowFrom: ["qqbot:user123"],
          execApprovals: {
            approvers: ["QQBot:USER123"],
          },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: { qqbot: { allowFrom: ["USER123"] } },
    });
  });

  it("locks implicit wildcard approvals while preserving open DMs", () => {
    const wildcard = migrate({ channels: { qqbot: { allowFrom: ["*"] } } });
    const missing = migrate({ channels: { qqbot: { appId: "app" } } });
    const mixed = migrate({
      channels: { qqbot: { dmPolicy: "allowlist", allowFrom: ["*", "admin"] } },
    });

    expect(wildcard.config).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["openclaw:approval-disabled"],
          dmPolicy: "open",
        },
      },
    });
    expect(missing.config).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["openclaw:approval-disabled"],
          dmPolicy: "open",
        },
      },
    });
    expect(mixed.config).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["ADMIN"],
          dmPolicy: "open",
        },
      },
    });
  });

  it("remains valid and idempotent through the later open-policy doctor repair", () => {
    const migrated = migrate({ channels: { qqbot: { allowFrom: ["*"] } } });
    const repaired = maybeRepairOpenPolicyAllowFrom(migrated.config);
    const repairedAgain = maybeRepairOpenPolicyAllowFrom(repaired.config);
    const schema = widenOfficialExternalChannelSecretSchema({
      channelId: "qqbot",
      schema: { type: "object", additionalProperties: true },
    });

    expect(repaired.changes).toEqual([]);
    expect(repaired.config).toMatchObject({
      channels: {
        qqbot: {
          dmPolicy: "open",
          allowFrom: ["openclaw:approval-disabled"],
        },
      },
    });
    expect(repairedAgain).toEqual({ config: repaired.config, changes: [] });
    expect(
      validateJsonSchemaValue({
        cacheKey: "qqbot-doctor-order-regression",
        schema: schema ?? {},
        value: (repaired.config.channels as { qqbot: unknown }).qqbot,
      }).ok,
    ).toBe(true);
  });

  it("keeps an explicit empty DM allowlist restrictive", () => {
    const result = migrate({
      channels: {
        qqbot: {
          dmPolicy: "allowlist",
          allowFrom: [],
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          dmPolicy: "allowlist",
          allowFrom: ["openclaw:approval-disabled"],
        },
      },
    });
  });

  it("flattens accounts.default with its overrides while preserving restrictive policy", () => {
    const inherited = migrate({
      channels: {
        qqbot: {
          dmPolicy: "allowlist",
          allowFrom: [],
          defaultAccount: "default",
          accounts: {
            default: { appId: "default-app" },
          },
        },
      },
    });
    const overridden = migrate({
      channels: {
        qqbot: {
          allowFrom: [],
          accounts: {
            default: { appId: "default-app", dmPolicy: "allowlist" },
          },
        },
      },
    });

    expect(inherited.config).toMatchObject({
      channels: {
        qqbot: {
          appId: "default-app",
          dmPolicy: "allowlist",
          allowFrom: ["openclaw:approval-disabled"],
        },
      },
    });
    expect(overridden.config).toMatchObject({
      channels: {
        qqbot: {
          appId: "default-app",
          dmPolicy: "allowlist",
          allowFrom: ["openclaw:approval-disabled"],
        },
      },
    });
  });

  it("preserves a named default account by moving it to Tencent's first-account position", () => {
    const result = migrate({
      channels: {
        qqbot: {
          defaultAccount: "Ops",
          accounts: {
            secondary: { appId: "secondary-app", allowFrom: ["SECONDARY"] },
            ops: { appId: "ops-app", allowFrom: ["ops-user"] },
          },
        },
      },
    });
    const qqbot = (result.config.channels as { qqbot: Record<string, unknown> }).qqbot;
    const accounts = qqbot.accounts as Record<string, unknown>;

    expect(Object.keys(accounts)).toEqual(["ops", "secondary"]);
    expect(qqbot).not.toHaveProperty("defaultAccount");
    expect(accounts.ops).toMatchObject({ appId: "ops-app", allowFrom: ["OPS-USER"] });
  });

  it("preserves the bundled plugin's lowercase selection for case-colliding accounts", () => {
    const result = migrate({
      channels: {
        qqbot: {
          defaultAccount: "Ops",
          accounts: {
            Ops: { appId: "uppercase-app", allowFrom: ["UPPER"] },
            ops: { appId: "lowercase-app", allowFrom: ["LOWER"] },
          },
        },
      },
    });
    const qqbot = (result.config.channels as { qqbot: Record<string, unknown> }).qqbot;
    const accounts = qqbot.accounts as Record<string, { appId?: string }>;

    expect(Object.keys(accounts)).toEqual(["ops", "Ops"]);
    expect(accounts.ops?.appId).toBe("lowercase-app");
  });

  it("fails closed when integer account keys prevent preserving a named default", () => {
    const result = migrate({
      channels: {
        qqbot: {
          defaultAccount: "ops",
          accounts: {
            "123": { appId: "numeric-app", allowFrom: ["NUMERIC"] },
            ops: { appId: "ops-app", allowFrom: ["OPS"] },
          },
        },
      },
    });
    const qqbot = (result.config.channels as { qqbot: Record<string, unknown> }).qqbot;

    expect(qqbot.defaultAccount).toBe("ops");
    expect(Object.keys(qqbot.accounts as Record<string, unknown>)).toEqual(["123", "ops"]);
  });

  it("locks native approvals when Tencent cannot represent the previous policy", () => {
    const result = migrate({
      channels: {
        qqbot: {
          allowFrom: ["*"],
          execApprovals: {
            enabled: false,
            approvers: ["admin"],
          },
          accounts: {
            filtered: {
              execApprovals: {
                approvers: ["admin"],
                agentFilter: ["ops"],
              },
            },
          },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["openclaw:approval-disabled"],
          dmPolicy: "open",
          accounts: {
            filtered: {
              allowFrom: ["openclaw:approval-disabled"],
              dmPolicy: "open",
            },
          },
        },
      },
    });
  });

  it("preserves open DMs while narrowing wildcard approval access", () => {
    const result = migrate({
      channels: {
        qqbot: {
          allowFrom: ["*"],
          execApprovals: { approvers: ["admin"] },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["ADMIN"],
          dmPolicy: "open",
        },
      },
    });
  });

  it("strips the legacy channel prefix from allowFrom IDs", () => {
    const result = migrate({
      channels: {
        qqbot: {
          allowFrom: ["qqbot:USER123", "QQBot:USER456", "user789", "*"],
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["USER123", "USER456", "USER789"],
          dmPolicy: "open",
        },
      },
    });
  });

  it("maps retired native streaming switches without enabling transport", () => {
    const result = migrate({
      channels: {
        qqbot: {
          streaming: { mode: "off", c2cStreamApi: true },
          accounts: {
            staticOnly: { streaming: { mode: "partial", nativeTransport: false } },
          },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          streaming: { mode: "partial" },
          accounts: {
            staticOnly: { streaming: { mode: "off" } },
          },
        },
      },
    });
    expect(JSON.stringify(result.config)).not.toContain("nativeTransport");
    expect(JSON.stringify(result.config)).not.toContain("c2cStreamApi");
  });

  it("keeps a restrictive allowFrom fallback when no explicit approvers were configured", () => {
    const result = migrate({
      channels: {
        qqbot: {
          allowFrom: ["admin"],
          execApprovals: { enabled: "auto" },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: { qqbot: { allowFrom: ["ADMIN"] } },
    });
  });

  it("maps current OpenClaw group tool policies to Tencent scalar policies", () => {
    const result = migrate({
      channels: {
        qqbot: {
          groups: {
            full: { tools: { allow: [] } },
            wildcard: { tools: { allow: ["*"] } },
            empty: { tools: {} },
            emptyDeny: { tools: { deny: [] } },
            additiveOnly: { tools: { alsoAllow: ["read"] } },
            restricted: { tools: { deny: ["write", "exec", "read"] } },
            restrictedEmptyAllow: {
              tools: { allow: [], deny: ["write", "exec", "read"] },
            },
            none: { tools: { deny: ["*"] } },
            custom: { tools: { allow: ["read"] } },
            senderSpecific: { toolsBySender: { admin: { allow: [] } } },
            coexist: { toolPolicy: "full", tools: { deny: ["*"] } },
            coexistSender: {
              toolPolicy: "full",
              toolsBySender: { admin: { allow: [] } },
            },
          },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          groups: {
            full: { toolPolicy: "full" },
            wildcard: { toolPolicy: "full" },
            empty: { toolPolicy: "full" },
            emptyDeny: { toolPolicy: "full" },
            additiveOnly: { toolPolicy: "full" },
            restricted: { toolPolicy: "restricted" },
            restrictedEmptyAllow: { toolPolicy: "restricted" },
            none: { toolPolicy: "none" },
            custom: { toolPolicy: "none" },
            senderSpecific: { toolPolicy: "none" },
            coexist: { toolPolicy: "none" },
            coexistSender: { toolPolicy: "none" },
          },
        },
      },
    });
    expect(JSON.stringify(result.config)).not.toContain('"tools"');
    expect(JSON.stringify(result.config)).not.toContain("toolsBySender");
  });

  it("removes all command levels and locks accounts with restrictive group commands", () => {
    const result = migrate({
      channels: {
        qqbot: {
          groups: {
            public: { commandLevel: "all" },
            sensitive: { commandLevel: "safety" },
          },
          accounts: {
            default: {
              groupPolicy: "open",
            },
            unrestricted: {
              groups: { "*": { commandLevel: "all" } },
            },
            strict: {
              groups: { "*": { commandLevel: "strict" } },
            },
          },
        },
      },
    });

    expect(result.config).toMatchObject({
      channels: {
        qqbot: {
          groupPolicy: "disabled",
          groups: {
            public: {},
            sensitive: {},
          },
          accounts: {
            unrestricted: {
              groups: { "*": {} },
            },
            strict: {
              groupPolicy: "disabled",
              groups: { "*": {} },
            },
          },
        },
      },
    });
    expect(JSON.stringify(result.config)).not.toContain("commandLevel");
  });
});
