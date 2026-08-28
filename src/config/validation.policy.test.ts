// Covers config validation policy decisions and warning behavior.
import { describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

vi.mock("../channels/plugins/legacy-config.js", () => ({
  collectChannelLegacyConfigRules: () => [],
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  collectDoctorConfigRepairPluginIds: () => [],
  collectRelevantDoctorPluginIds: () => [],
  listPluginDoctorLegacyConfigRules: () => [],
}));

vi.mock("../secrets/unsupported-surface-policy.js", async () => {
  const { isRecord } = await import("../utils.js");

  return {
    unsupportedSecretRefSurfacePolicy: {
      collectConfigCandidates: (raw: unknown) => {
        if (!isRecord(raw)) {
          return [];
        }
        const candidates: Array<{ path: string; value: unknown }> = [];

        const hooks = isRecord(raw.hooks) ? raw.hooks : null;
        if (hooks) {
          candidates.push({ path: "hooks.token", value: hooks.token });
        }

        const channels = isRecord(raw.channels) ? raw.channels : null;
        const discord = channels && isRecord(channels.discord) ? channels.discord : null;
        const threadBindings =
          discord && isRecord(discord.threadBindings) ? discord.threadBindings : null;
        if (threadBindings) {
          candidates.push({
            path: "channels.discord.threadBindings.webhookToken",
            value: threadBindings.webhookToken,
          });
        }

        return candidates;
      },
    },
  };
});

function requireIssue<T extends { path: string }>(issues: T[], path: string): T {
  const issue = issues.find((entry) => entry.path === path);
  if (!issue) {
    throw new Error(`expected validation issue at ${path}`);
  }
  return issue;
}

function createSecretFixturePlugin(): PluginManifestRecord {
  return {
    id: "secret-fixture",
    channels: [],
    cliBackends: [],
    configContracts: {
      secretInputs: { paths: [{ path: "credential", expected: "string" }] },
    },
    configSchema: { type: "object", additionalProperties: true },
    hooks: [],
    manifestPath: "/tmp/secret-fixture/openclaw.plugin.json",
    origin: "bundled",
    providers: [],
    rootDir: "/tmp/secret-fixture",
    skills: [],
    source: "/tmp/secret-fixture/index.js",
  };
}

describe("config validation SecretRef policy guards", () => {
  it("allows an impossible SecretRef on a disabled registry-declared plugin target", () => {
    const plugin = createSecretFixturePlugin();
    const result = validateConfigObjectRawWithPlugins(
      {
        plugins: {
          entries: {
            "secret-fixture": {
              enabled: false,
              config: {
                credential: {
                  source: "exec",
                  provider: "shared",
                  id: "PLUGIN_PRIVATE_CREDENTIAL",
                },
              },
            },
          },
        },
        secrets: {
          providers: {
            shared: { source: "file", path: "/tmp/unused-secrets.json", mode: "json" },
          },
        },
      },
      { pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [plugin] } } },
    );

    expect(result.ok).toBe(true);
  });

  it("strictly rejects an impossible SecretRef on a disabled registry-declared plugin target", () => {
    const refId = "PLUGIN_PRIVATE_CREDENTIAL";
    const plugin = createSecretFixturePlugin();
    const result = validateConfigObjectRawWithPlugins(
      {
        plugins: {
          entries: {
            "secret-fixture": {
              enabled: false,
              config: {
                credential: { source: "exec", provider: "shared", id: refId },
              },
            },
          },
        },
        secrets: {
          providers: {
            shared: { source: "file", path: "/tmp/unused-secrets.json", mode: "json" },
          },
        },
      },
      {
        semanticValidation: "strict",
        pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [plugin] } },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "plugins.entries.secret-fixture.config.credential");
      expect(issue.message).toContain(
        'Secret provider "shared" has source "file" but ref requests "exec"',
      );
      expect(JSON.stringify(result.issues)).not.toContain(refId);
    }
  });

  it.each(["env", "store"] as const)(
    "allows the %s default alias to shadow another-source provider entry",
    (source) => {
      const result = validateConfigObjectRawWithPlugins(
        {
          plugins: {
            entries: {
              "secret-fixture": {
                enabled: false,
                config: {
                  credential: { source, provider: "shared", id: "PLUGIN_PRIVATE_CREDENTIAL" },
                },
              },
            },
          },
          secrets: {
            defaults: { [source]: "shared" },
            providers: {
              shared: { source: "file", path: "/tmp/unused-secrets.json", mode: "json" },
            },
          },
        },
        {
          semanticValidation: "strict",
          pluginMetadataSnapshot: {
            manifestRegistry: { diagnostics: [], plugins: [createSecretFixturePlugin()] },
          },
        },
      );

      expect(result.ok).toBe(true);
    },
  );

  it("surfaces a policy error for hooks.token SecretRef objects", () => {
    const result = validateConfigObjectRaw({
      hooks: {
        token: {
          source: "env",
          provider: "default",
          id: "HOOK_TOKEN",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "hooks.token");
      expect(issue.message).toContain("SecretRef objects are not supported at hooks.token");
      expect(issue.message).toContain(
        "https://docs.openclaw.ai/reference/secretref-credential-surface",
      );
      expect(
        result.issues.some(
          (entry) =>
            entry.path === "hooks.token" &&
            entry.message.includes("Invalid input: expected string, received object"),
        ),
      ).toBe(false);
    }
  });

  it("keeps standard schema errors for non-SecretRef objects", () => {
    const result = validateConfigObjectRaw({
      hooks: {
        token: {
          unexpected: "value",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "hooks.token");
      expect(issue.message).toBe("Invalid input: expected string, received object");
    }
  });

  it("allows env-template strings on unsupported mutable paths", () => {
    const result = validateConfigObjectRaw({
      hooks: {
        token: "${HOOK_TOKEN}",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("leaves legacy secretref-env marker migration to doctor", () => {
    const result = validateConfigObjectRaw({
      secrets: {
        defaults: {
          env: "gateway-env",
        },
      },
      channels: {
        discord: {
          token: "secretref-env:DISCORD_BOT_TOKEN",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("does not reject invalid legacy secretref-env markers during raw validation", () => {
    const result = validateConfigObjectRaw({
      channels: {
        discord: {
          token: "secretref-env:not-valid",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("replaces derived unrecognized-key errors with policy guidance for discord thread binding webhookToken", () => {
    const result = validateConfigObjectRaw({
      channels: {
        discord: {
          threadBindings: {
            webhookToken: {
              source: "env",
              provider: "default",
              id: "DISCORD_THREAD_BINDING_WEBHOOK_TOKEN",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const policyIssue = requireIssue(
        result.issues,
        "channels.discord.threadBindings.webhookToken",
      );
      expect(policyIssue.message).toContain(
        "SecretRef objects are not supported at channels.discord.threadBindings.webhookToken",
      );
      expect(
        result.issues.some(
          (entry) =>
            entry.path === "channels.discord.threadBindings" &&
            entry.message.includes('Unrecognized key: "webhookToken"'),
        ),
      ).toBe(false);
    }
  });

  it("preserves unrelated unknown-key errors when policy and typos coexist", () => {
    const result = validateConfigObjectRaw({
      channels: {
        discord: {
          threadBindings: {
            webhookToken: {
              source: "env",
              provider: "default",
              id: "DISCORD_THREAD_BINDING_WEBHOOK_TOKEN",
            },
            webhookTokne: "typo",
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (entry) =>
            entry.path === "channels.discord.threadBindings.webhookToken" &&
            entry.message.includes("SecretRef objects are not supported"),
        ),
      ).toBe(true);
      expect(
        result.issues.some(
          (entry) =>
            entry.path === "channels.discord.threadBindings" &&
            entry.message.includes("webhookTokne"),
        ),
      ).toBe(true);
      const schemaIssue = requireIssue(result.issues, "channels.discord.threadBindings");
      expect(schemaIssue.message).toContain("webhookTokne");
      expect(schemaIssue.message).not.toContain("webhookToken");
    }
  });
});

describe("config validation gateway.port policy", () => {
  it("rejects gateway.port values outside the 1–65535 TCP range", () => {
    // port 0 — not a valid TCP port
    const zero = validateConfigObjectRaw({ gateway: { port: 0 } });
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      const issue = requireIssue(zero.issues, "gateway.port");
      expect(issue.message).toContain("expected number to be >=1");
    }

    // port 65536 — above TCP max
    const above = validateConfigObjectRaw({ gateway: { port: 65_536 } });
    expect(above.ok).toBe(false);
    if (!above.ok) {
      const issue = requireIssue(above.issues, "gateway.port");
      expect(issue.message).toBeDefined();
    }

    // port 65535 — valid TCP max
    const valid = validateConfigObjectRaw({ gateway: { port: 65_535 } });
    expect(valid.ok).toBe(true);

    // port 1 — valid TCP min
    const min = validateConfigObjectRaw({ gateway: { port: 1 } });
    expect(min.ok).toBe(true);
  });
});

describe("config validation ambient heartbeat ownership", () => {
  const validate = (raw: unknown) =>
    validateConfigObjectWithPlugins(raw, {
      pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [] } },
    });
  const heartbeatOwnerWarnings = (raw: unknown) => {
    const result = validate(raw);
    expect(result.ok).toBe(true);
    return result.warnings.filter(
      (warning) => warning.path === "agents.defaults.heartbeat.agentId",
    );
  };

  it("warns that heartbeats stay disabled for an ownerless explicit multi-agent roster", () => {
    expect(
      heartbeatOwnerWarnings({
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      }),
    ).toEqual([
      {
        path: "agents.defaults.heartbeat.agentId",
        message:
          "Multi-agent config has no ambient heartbeat owner; heartbeats stay disabled until agents.defaults.heartbeat.agentId or agents.defaults.systemAgent.agentId is set.",
      },
    ]);
  });

  it.each([
    {
      name: "system owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { systemAgent: { agentId: "ops" } },
        },
      },
    },
    {
      name: "single-agent roster",
      cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
    },
    {
      name: "per-agent heartbeat",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: { heartbeat: { every: "30m" } } },
        },
      },
    },
    {
      name: "broadcast heartbeat defaults",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { heartbeat: { every: "30m" } },
        },
      },
    },
    {
      name: "legacy default marker",
      cfg: { agents: { entries: { main: { default: true }, ops: {} } } },
    },
  ])("does not warn for a $name", ({ cfg }) => {
    expect(heartbeatOwnerWarnings(cfg)).toEqual([]);
  });
});
