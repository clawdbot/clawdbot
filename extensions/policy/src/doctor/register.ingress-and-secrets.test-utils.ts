// Imported by register.test.ts to keep its mocked suite in one Vitest module graph.
import { runDoctorLintChecks, type OpenClawConfig } from "openclaw/plugin-sdk/health";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPolicyEvidence } from "../policy-state.js";
import { registerPolicyDoctorChecks } from "./register.js";
import {
  cfgWithPolicy,
  ctx,
  runPolicyChecks,
  runPolicyDoctorLint,
  setupPolicyDoctorTest,
  teardownPolicyDoctorTest,
  writePolicyFixture,
} from "./register.test-harness.js";

const scanPolicyIngress = (cfg: object) =>
  collectPolicyEvidence(cfg as Record<string, unknown>).ingress ?? [];

type PolicyScenarioMode = "doctor" | "global-doctor" | "checks";

const INGRESS_POLICY = {
  ingress: {
    session: { requireDmScope: "per-channel-peer" },
    channels: {
      allowDmPolicies: ["pairing", "allowlist", "disabled"],
      denyOpenGroups: true,
      requireMentionInGroups: true,
    },
  },
};

async function runPolicyScenario(cfg: OpenClawConfig, policy: object, mode: PolicyScenarioMode) {
  const configPath = await writePolicyFixture(policy);
  const checkContext = ctx(configPath, cfg);
  if (mode === "doctor") {
    return runPolicyDoctorLint(checkContext);
  }
  if (mode === "global-doctor") {
    registerPolicyDoctorChecks();
    return runDoctorLintChecks(checkContext);
  }
  return runPolicyChecks(checkContext);
}

async function runIngressPolicyScenario(channels: Record<string, unknown>) {
  const cfg = configWithPolicy({
    session: { dmScope: "per-channel-peer" },
    channels,
  });
  return {
    cfg,
    result: await runPolicyScenario(cfg, INGRESS_POLICY, "doctor"),
  };
}

function configWithPolicy(overrides: object): OpenClawConfig {
  return { ...cfgWithPolicy(), ...overrides } as unknown as OpenClawConfig;
}

function configWithAgents(agents: object): OpenClawConfig {
  return configWithPolicy({ agents });
}

function configWithSandbox(sandbox: object): OpenClawConfig {
  return configWithAgents({ defaults: { sandbox } });
}

function workspacePolicy(allowedAccess: string[], denyTools?: string[]) {
  return {
    agents: {
      workspace: {
        allowedAccess,
        ...(denyTools ? { denyTools } : {}),
      },
    },
  };
}

function managedSecretsPolicy(denySources?: string[], allowInsecureProviders?: boolean) {
  return {
    secrets: {
      requireManagedProviders: true,
      ...(denySources ? { denySources } : {}),
      ...(allowInsecureProviders === undefined ? {} : { allowInsecureProviders }),
    },
  };
}

function policyAgentScope(agentIds: string[], allowedAccess?: string[], allowHosts?: string[]) {
  return {
    agentIds,
    ...(allowedAccess ? { agents: { workspace: { allowedAccess } } } : {}),
    ...(allowHosts ? { tools: { exec: { allowHosts } } } : {}),
  };
}

describe("registerPolicyDoctorChecks", () => {
  beforeEach(setupPolicyDoctorTest);

  afterEach(teardownPolicyDoctorTest);

  it("ignores nested groupPolicy when channel ingress is disabled", async () => {
    const { result } = await runIngressPolicyScenario({
      telegram: {
        dmPolicy: "pairing",
        groupPolicy: "disabled",
        groups: {
          ops: {
            groupPolicy: "open",
            requireMention: false,
          },
        },
      },
    });

    expect(result.findings).toEqual([]);
  });

  it("does not let nested groupPolicy re-enable disabled channel ingress", async () => {
    const { result } = await runIngressPolicyScenario({
      telegram: {
        dmPolicy: "pairing",
        groupPolicy: "disabled",
        groups: {
          ops: {
            topics: {
              incidents: { groupPolicy: "open", requireMention: false },
            },
          },
        },
      },
    });

    expect(result.findings).toEqual([]);
  });

  it("does not treat disabled parent groupPolicy as nested runtime enforcement", async () => {
    const { result } = await runIngressPolicyScenario({
      telegram: {
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        requireMention: true,
        groups: {
          ops: {
            groupPolicy: "disabled",
            topics: {
              incidents: { requireMention: false },
            },
          },
        },
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-group-mention-required",
          ocPath:
            "oc://openclaw.config/channels/telegram/groups/ops/topics/incidents/requireMention",
        }),
      ]),
    );
  });

  it("does not require mention gates when group ingress is disabled", async () => {
    const { result } = await runIngressPolicyScenario({
      telegram: {
        dmPolicy: "pairing",
        groupPolicy: "disabled",
      },
    });

    expect(result.findings).toEqual([]);
  });

  it("does not require mention gates when group ingress is disabled by channel defaults", async () => {
    const { result } = await runIngressPolicyScenario({
      defaults: { groupPolicy: "disabled" },
      telegram: {
        dmPolicy: "pairing",
        requireMention: false,
      },
    });

    expect(result.findings).toEqual([]);
  });

  it("accepts wildcard group mention defaults as channel mention posture", async () => {
    const { cfg, result } = await runIngressPolicyScenario({
      telegram: {
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        groups: {
          "*": { requireMention: true },
        },
      },
    });
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "channelRequireMention",
          source: 'oc://openclaw.config/channels/telegram/groups/"*"/requireMention',
          value: true,
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("records only supported inherited channel defaults in ingress posture", () => {
    const cfg = {
      channels: {
        defaults: {
          dmPolicy: "open",
          groupPolicy: "open",
          requireMention: false,
        },
        telegram: {},
        slack: {
          accounts: {
            work: {},
          },
        },
      },
    };

    expect(scanPolicyIngress(cfg)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "telegram", kind: "channelGroupPolicy", value: "open" }),
        expect.objectContaining({
          accountId: "work",
          kind: "channelDmPolicy",
          value: "pairing",
        }),
        expect.objectContaining({
          accountId: "work",
          kind: "channelRequireMention",
          value: true,
        }),
      ]),
    );
  });

  it("uses Feishu open-group mention defaults", async () => {
    const cfg = configWithPolicy({
      channels: {
        feishu: {
          groupPolicy: "open",
        },
      },
    });
    const policy = {
      ingress: {
        channels: {
          requireMentionInGroups: true,
        },
      },
    };

    const result = await runPolicyScenario(cfg, policy, "doctor");
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "feishu",
          kind: "channelRequireMention",
          value: false,
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-group-mention-required",
          ocPath: "oc://openclaw.config/channels/feishu/requireMention",
        }),
      ]),
    );
  });

  it.each([
    ["clickclack", { baseUrl: "https://app.clickclack.chat", workspace: "wsp_1", token: "ccb" }],
    ["feishu", { appId: "cli_a", appSecret: "secret" }],
    ["irc", { host: "irc.example.com", nick: "claw" }],
    ["line", { channelAccessToken: "line-token" }],
    ["mattermost", { baseUrl: "https://mattermost.example.com", botToken: "mm-token" }],
    ["nextcloud-talk", { baseUrl: "https://nextcloud.example.com", botSecret: "nc-secret" }],
    ["qqbot", { appId: "qqbot-app", clientSecret: "qqbot-secret" }],
    ["synology-chat", { token: "synology-token" }],
    ["tlon", { ship: "zod" }],
    ["twitch", { username: "openclaw" }],
  ])("evaluates %s implicit default account posture with named accounts", async (channel, root) => {
    const { result } = await runIngressPolicyScenario({
      [channel]: {
        ...root,
        dmPolicy: "open",
        groupPolicy: "allowlist",
        requireMention: true,
        accounts: {
          work: {
            dmPolicy: "allowlist",
            groupPolicy: "allowlist",
            requireMention: true,
          },
        },
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-dm-policy-unapproved",
          ocPath: `oc://openclaw.config/channels/${channel}/dmPolicy`,
        }),
      ]),
    );
  });

  it("does not evaluate channels with only disabled named accounts", async () => {
    const { cfg, result } = await runIngressPolicyScenario({
      slack: {
        accounts: {
          work: {
            enabled: false,
            dmPolicy: "open",
            groupPolicy: "open",
            requireMention: false,
          },
        },
      },
    });
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(result.findings).toEqual([]);
    expect(evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "slack",
          kind: "channelDmPolicy",
        }),
      ]),
    );
  });

  it("does not evaluate channel root defaults as a named account", async () => {
    const { cfg, result } = await runIngressPolicyScenario({
      slack: {
        accounts: {
          work: {
            dmPolicy: "allowlist",
            groupPolicy: "allowlist",
            requireMention: true,
          },
        },
      },
    });
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(result.findings).toEqual([]);
    expect(evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "slack",
          accountId: undefined,
          kind: "channelDmPolicy",
        }),
      ]),
    );
  });

  it("evaluates implicit default account posture with named accounts", async () => {
    const { result } = await runIngressPolicyScenario({
      discord: {
        token: "root-token",
        dmPolicy: "open",
        groupPolicy: "allowlist",
        requireMention: true,
        accounts: {
          work: {
            dmPolicy: "allowlist",
            groupPolicy: "allowlist",
            requireMention: true,
          },
        },
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-dm-policy-unapproved",
          ocPath: "oc://openclaw.config/channels/discord/dmPolicy",
        }),
      ]),
    );
  });

  it("records inherited Telegram root groups for multi-account named accounts", async () => {
    const { cfg, result } = await runIngressPolicyScenario({
      telegram: {
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        groups: {
          ops: {
            groupPolicy: "open",
            requireMention: false,
          },
        },
        accounts: {
          work: {
            botToken: "work-token",
            dmPolicy: "allowlist",
            groupPolicy: "allowlist",
            requireMention: true,
          },
          personal: {
            botToken: "personal-token",
            dmPolicy: "allowlist",
            groupPolicy: "allowlist",
            requireMention: true,
          },
        },
      },
    });
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "work",
          groupId: "ops",
          kind: "channelRequireMention",
          source: "oc://openclaw.config/channels/telegram/groups/ops/requireMention",
          value: false,
        }),
        expect.objectContaining({
          accountId: "personal",
          groupId: "ops",
          kind: "channelRequireMention",
          source: "oc://openclaw.config/channels/telegram/groups/ops/requireMention",
          value: false,
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-group-mention-required",
          ocPath: "oc://openclaw.config/channels/telegram/groups/ops/requireMention",
          message: expect.stringContaining("account 'work'"),
        }),
        expect.objectContaining({
          checkId: "policy/ingress-group-mention-required",
          ocPath: "oc://openclaw.config/channels/telegram/groups/ops/requireMention",
          message: expect.stringContaining("account 'personal'"),
        }),
      ]),
    );
  });

  it("lets an explicit Telegram account groups map override root inheritance", () => {
    const cfg = {
      channels: {
        telegram: {
          groups: {
            ops: {
              groupPolicy: "open",
              requireMention: false,
            },
          },
          accounts: {
            work: {
              groups: {},
            },
            personal: {},
          },
        },
      },
    };

    const evidence = scanPolicyIngress(cfg);

    expect(evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "work",
          groupId: "ops",
          kind: "channelRequireMention",
        }),
      ]),
    );
  });

  it("inherits root groups through a single Telegram account empty map", () => {
    const cfg = {
      channels: {
        telegram: {
          groups: {
            ops: {
              requireMention: false,
            },
          },
          accounts: {
            work: {
              groups: {},
            },
          },
        },
      },
    };

    expect(scanPolicyIngress(cfg)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "work",
          groupId: "ops",
          kind: "channelRequireMention",
          source: "oc://openclaw.config/channels/telegram/groups/ops/requireMention",
          value: false,
        }),
      ]),
    );
  });

  it("records inherited root group overrides for multi-account ingress", async () => {
    const { cfg, result } = await runIngressPolicyScenario({
      slack: {
        botToken: "root-token",
        dmPolicy: "pairing",
        groupPolicy: "disabled",
        groups: {
          ops: {
            groupPolicy: "open",
            requireMention: false,
          },
        },
        accounts: {
          work: {
            dmPolicy: "allowlist",
          },
          personal: {
            dmPolicy: "allowlist",
          },
        },
      },
    });
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "work",
          groupId: "ops",
          kind: "channelRequireMention",
          source: "oc://openclaw.config/channels/slack/groups/ops/requireMention",
          value: false,
        }),
        expect.objectContaining({
          accountId: "personal",
          groupId: "ops",
          kind: "channelRequireMention",
          source: "oc://openclaw.config/channels/slack/groups/ops/requireMention",
          value: false,
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("evaluates Telegram implicit default account posture with named accounts", async () => {
    const { result } = await runIngressPolicyScenario({
      telegram: {
        botToken: "root-token",
        dmPolicy: "open",
        groupPolicy: "allowlist",
        requireMention: true,
        accounts: {
          work: {
            dmPolicy: "allowlist",
            groupPolicy: "allowlist",
            requireMention: true,
          },
        },
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-dm-policy-unapproved",
          ocPath: "oc://openclaw.config/channels/telegram/dmPolicy",
        }),
      ]),
    );
  });

  it("accepts inherited account ingress posture", async () => {
    const { cfg, result } = await runIngressPolicyScenario({
      slack: {
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        requireMention: true,
        accounts: {
          work: {},
        },
      },
    });
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(result.findings).toEqual([]);
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack-work-dm-policy",
          kind: "channelDmPolicy",
          source: "oc://openclaw.config/channels/slack/dmPolicy",
          value: "allowlist",
        }),
      ]),
    );
  });

  it("reports private-network SSRF settings denied by policy", async () => {
    const cfg = configWithPolicy({
      browser: {
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              allowIpv6UniqueLocalRange: true,
            },
          },
        },
      },
    });
    const policy = {
      network: {
        privateNetwork: { allow: false },
      },
    };

    const result = await runPolicyScenario(cfg, policy, "doctor");

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/network-private-access-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
        requirement: "oc://policy.jsonc/network/privateNetwork/allow",
      }),
      expect.objectContaining({
        checkId: "policy/network-private-access-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowIpv6UniqueLocalRange",
        requirement: "oc://policy.jsonc/network/privateNetwork/allow",
      }),
    ]);
  });

  it("reports secret provider conformance findings without leaking secret values", async () => {
    const cfg = configWithPolicy({
      secrets: {
        providers: {
          vault: { source: "file", path: ".secrets.json", allowInsecurePath: true },
          command: { source: "exec", command: "vault", args: ["read", "openai/api-key"] },
        },
      },
      models: {
        providers: {
          anthropic: { apiKey: { source: "env", provider: "missing", id: "ANTHROPIC_API_KEY" } },
        },
      },
    });
    const policy = managedSecretsPolicy(["exec"], false);

    const result = await runPolicyScenario(cfg, policy, "global-doctor");
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(JSON.stringify(evidence)).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(result.findings)).not.toContain("ANTHROPIC_API_KEY");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          severity: "error",
          ocPath: "oc://openclaw.config/models/providers/anthropic/apiKey",
          requirement: "oc://policy.jsonc/secrets/requireManagedProviders",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          severity: "error",
          ocPath: "oc://openclaw.config/secrets/providers/command",
          requirement: "oc://policy.jsonc/secrets/denySources",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(2);
  });

  it("checks managed providers for structured provider request SecretRefs", async () => {
    const baseCfg = cfgWithPolicy();
    const cfg = {
      ...baseCfg,
      models: {
        providers: {
          openai: {
            request: {
              auth: {
                mode: "authorization-bearer",
                token: { source: "exec", provider: "rogue", id: "openai/bearer-token" },
              },
              tls: {
                passphrase: { source: "exec", provider: "rogue", id: "tls/passphrase" },
              },
            },
          },
          "z.ai": {
            headers: {
              Authorization: { source: "exec", provider: "rogue", id: "zai/authorization" },
            },
          },
        },
      },
      tools: {
        media: {
          models: [
            {
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: { source: "exec", provider: "rogue", id: "media/shared-token" },
                },
                tls: {
                  key: { source: "exec", provider: "rogue", id: "media/tls/key" },
                },
              },
            },
            {
              capabilities: ["image"],
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: { source: "exec", provider: "rogue", id: "media/image-token" },
                },
              },
            },
          ],
          audio: {
            request: {
              auth: {
                mode: "authorization-bearer",
                token: { source: "exec", provider: "rogue", id: "media/audio-token" },
              },
            },
          },
        },
      },
      plugins: {
        ...baseCfg.plugins,
        entries: {
          ...baseCfg.plugins?.entries,
          acpx: {
            config: {
              mcpServers: {
                github: {
                  env: {
                    GITHUB_TOKEN: { source: "exec", provider: "rogue", id: "github/token" },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = managedSecretsPolicy(["exec"]);

    const result = await runPolicyScenario(cfg, policy, "global-doctor");
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/models/providers/openai/request/auth/token",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/models/providers/openai/request/tls/passphrase",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: 'oc://openclaw.config/models/providers/"z.ai"/headers/Authorization',
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source:
            "oc://openclaw.config/plugins/entries/acpx/config/mcpServers/github/env/GITHUB_TOKEN",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/tools/media/models/#0/request/auth/token",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/tools/media/models/#0/request/tls/key",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/tools/media/audio/request/auth/token",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/tools/media/models/#1/request/auth/token",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/models/providers/openai/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath: "oc://openclaw.config/models/providers/openai/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/models/providers/openai/request/tls/passphrase",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath: "oc://openclaw.config/models/providers/openai/request/tls/passphrase",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: 'oc://openclaw.config/models/providers/"z.ai"/headers/Authorization',
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath:
            "oc://openclaw.config/plugins/entries/acpx/config/mcpServers/github/env/GITHUB_TOKEN",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/tools/media/models/#0/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath: "oc://openclaw.config/tools/media/audio/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/tools/media/models/#1/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/tools/media/models/#0/request/tls/key",
        }),
      ]),
    );
  });

  it("honors configured secret default providers when checking managed providers", async () => {
    const cfg = configWithPolicy({
      secrets: {
        defaults: {
          env: "vault",
        },
        providers: {
          vault: { source: "env" },
        },
      },
      models: {
        providers: {
          openai: { apiKey: "$OPENAI_API_KEY" },
        },
      },
    });
    const policy = managedSecretsPolicy();

    const result = await runPolicyScenario(cfg, policy, "global-doctor");
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "env",
          refProvider: "vault",
          source: "oc://openclaw.config/models/providers/openai/apiKey",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("reports SecretRefs that use a managed provider alias with the wrong source", async () => {
    const cfg = configWithPolicy({
      secrets: {
        providers: {
          vault: { source: "file", path: ".secrets.json" },
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "vault", id: "OPENAI_API_KEY" },
          },
        },
      },
    });
    const policy = managedSecretsPolicy();

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/secrets-unmanaged-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/models/providers/openai/apiKey",
        requirement: "oc://policy.jsonc/secrets/requireManagedProviders",
      }),
    ]);
  });

  it("does not treat raw MCP env values as SecretRefs", async () => {
    const cfg = configWithPolicy({
      mcp: {
        servers: {
          "corp.github": {
            env: {
              APP_ID: "$GITHUB_APP_ID",
              GITHUB_TOKEN: "$GITHUB_TOKEN",
            },
          },
        },
      },
    });
    const policy = managedSecretsPolicy(["env"]);

    const result = await runPolicyScenario(cfg, policy, "global-doctor");
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.secrets).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("checks configured channel encryptKey SecretRefs", async () => {
    const cfg = configWithPolicy({
      channels: {
        feishu: {
          encryptKey: { source: "exec", provider: "rogue", id: "feishu/encrypt-key" },
        },
      },
    });
    const policy = managedSecretsPolicy(["exec"]);

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/channels/feishu/encryptKey",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath: "oc://openclaw.config/channels/feishu/encryptKey",
        }),
      ]),
    );
  });

  it("reports agent workspace posture denied by policy", async () => {
    const cfg = configWithPolicy({
      tools: {
        deny: ["write", "edit"],
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "rw" },
        },
        list: [
          {
            id: "reviewer",
            sandbox: { workspaceAccess: "ro" },
            tools: { deny: ["group:fs", "group:runtime"] },
          },
        ],
      },
    });
    const policy = workspacePolicy(
      ["none", "ro"],
      ["exec", "process", "write", "edit", "apply_patch"],
    );

    const result = await runPolicyScenario(cfg, policy, "global-doctor");
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.agentWorkspace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agents-defaults-workspace-access",
          kind: "workspaceAccess",
          value: "rw",
          sandboxMode: "all",
          sandboxEnabled: true,
          source: "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
        }),
        expect.objectContaining({
          id: "reviewer-tool-apply_patch",
          kind: "toolDeny",
          tool: "apply_patch",
          denied: true,
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          severity: "error",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/agents-tool-not-denied",
          severity: "error",
          ocPath: "oc://openclaw.config/tools/deny",
          requirement: "oc://policy.jsonc/agents/workspace/denyTools",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-tool-not-denied",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/deny",
        }),
      ]),
    );
  });

  it("accepts sandbox-scoped tool denies for read-only agent workspace policy", async () => {
    const cfg = configWithPolicy({
      tools: {
        sandbox: { tools: { deny: ["group:runtime", "group:fs"] } },
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
        list: [
          {
            id: "locked",
            sandbox: { workspaceAccess: "none" },
            tools: { sandbox: { tools: { deny: ["group:runtime", "group:fs"] } } },
          },
        ],
      },
    });
    const policy = workspacePolicy(
      ["none", "ro"],
      ["exec", "process", "write", "edit", "apply_patch"],
    );

    const result = await runPolicyScenario(cfg, policy, "global-doctor");
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.agentWorkspace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agents-defaults-tool-exec",
          denied: true,
          source: "oc://openclaw.config/tools/sandbox/tools/deny",
        }),
        expect.objectContaining({
          id: "locked-tool-apply_patch",
          denied: true,
          source: "oc://openclaw.config/agents/list/#0/tools/sandbox/tools/deny",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("accepts runtime tool deny globs for agent workspace policy", async () => {
    const cfg = configWithPolicy({
      tools: {
        deny: ["e*"],
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
      },
    });
    const policy = workspacePolicy(["ro"], ["exec"]);

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual([]);
  });

  it("reports sandbox tool deny overrides outside policy", async () => {
    const cfg = configWithPolicy({
      tools: {
        sandbox: { tools: { deny: ["exec"] } },
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
        list: [
          {
            id: "locked",
            sandbox: { workspaceAccess: "none" },
            tools: { sandbox: { tools: { deny: ["group:fs"] } } },
          },
        ],
      },
    });
    const policy = workspacePolicy(["none", "ro"], ["exec"]);

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/agents-tool-not-denied",
        message: "agent 'locked' does not deny required tool 'exec'.",
        ocPath: "oc://openclaw.config/agents/list/#0/tools/deny",
        requirement: "oc://policy.jsonc/agents/workspace/denyTools",
      }),
    ]);
  });

  it("accepts read-only agent workspace policy with group denies", async () => {
    const cfg = configWithPolicy({
      tools: {
        deny: ["group:runtime", "group:fs"],
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
        list: [
          {
            id: "locked",
            sandbox: { workspaceAccess: "none" },
          },
        ],
      },
    });
    const policy = workspacePolicy(
      ["none", "ro"],
      ["exec", "process", "write", "edit", "apply_patch"],
    );

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual([]);
  });

  it("reports read-only workspace policy when sandbox mode skips the main session", async () => {
    const cfg = configWithPolicy({
      tools: {
        sandbox: { tools: { deny: ["exec"] } },
      },
      agents: {
        defaults: {
          sandbox: { mode: "non-main", workspaceAccess: "ro" },
        },
      },
    });
    const policy = workspacePolicy(["ro"], ["exec"]);

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          message: "agents.defaults sandbox mode 'non-main' is not allowed by policy.",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
          requirement: "oc://policy.jsonc/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/agents-tool-not-denied",
          message: "agents.defaults does not deny required tool 'exec'.",
          ocPath: "oc://openclaw.config/tools/deny",
          requirement: "oc://policy.jsonc/agents/workspace/denyTools",
        }),
      ]),
    );
  });

  it("reports read-only workspace policy when sandbox mode is disabled", async () => {
    const cfg = configWithPolicy({
      tools: {
        deny: ["group:runtime", "group:fs"],
      },
      agents: {
        defaults: {
          sandbox: { workspaceAccess: "ro" },
        },
      },
    });
    const policy = workspacePolicy(
      ["none", "ro"],
      ["exec", "process", "write", "edit", "apply_patch"],
    );

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/agents-workspace-access-denied",
        message: "agents.defaults sandbox mode 'off' is not allowed by policy.",
        ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
        requirement: "oc://policy.jsonc/agents/workspace/allowedAccess",
      }),
    ]);
  });

  it("reports global and agent-scoped workspace claims independently", async () => {
    const cfg = configWithAgents({
      defaults: {
        sandbox: { mode: "all", workspaceAccess: "ro" },
      },
      list: [
        { id: "sebby", sandbox: { mode: "all", workspaceAccess: "rw" } },
        { id: "buddy", sandbox: { mode: "all", workspaceAccess: "ro" } },
      ],
    });
    const policy = {
      agents: {
        workspace: {
          allowedAccess: ["none", "ro"],
        },
      },
      scopes: {
        sebby: policyAgentScope(["sebby"], ["none"]),
      },
    };

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/sebby/agents/workspace/allowedAccess",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#1/sandbox/workspaceAccess",
        }),
      ]),
    );
  });

  it("allows purpose-named agent scopes to target multiple agents", async () => {
    const cfg = configWithAgents({
      list: [
        { id: "sebby", sandbox: { mode: "all", workspaceAccess: "rw" } },
        { id: "buddy", sandbox: { mode: "all", workspaceAccess: "rw" } },
      ],
    });
    const policy = {
      scopes: {
        "workspace-lockdown": policyAgentScope(["sebby", "buddy"], ["ro"]),
      },
    };

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/workspace-lockdown/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#1/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/workspace-lockdown/agents/workspace/allowedAccess",
        }),
      ]),
    );
  });

  it("allows overlapping agent scopes when they govern different fields", async () => {
    const cfg = configWithAgents({
      list: [
        {
          id: "sebby",
          sandbox: { mode: "all", workspaceAccess: "rw" },
          tools: { exec: { host: "node" } },
        },
      ],
    });
    const policy = {
      scopes: {
        "workspace-lockdown": policyAgentScope(["sebby"], ["ro"]),
        "exec-posture": policyAgentScope(["sebby"], undefined, ["sandbox"]),
      },
    };

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: "oc://policy.jsonc/scopes/workspace-lockdown/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          requirement: "oc://policy.jsonc/scopes/exec-posture/tools/exec/allowHosts",
        }),
      ]),
    );
  });

  it("rejects overlapping agent scopes that govern the same field", async () => {
    const policy = {
      scopes: {
        "coding-posture": policyAgentScope(["Sebby"], undefined, ["sandbox"]),
        "strict-exec": policyAgentScope(["sebby"], undefined, ["gateway"]),
      },
    };

    const result = await runPolicyScenario(cfgWithPolicy(), policy, "global-doctor");

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        target: "oc://policy.jsonc/scopes/strict-exec/tools/exec/allowHosts",
      }),
    ]);
  });

  it("does not apply agent-scoped workspace claims to other agents", async () => {
    const cfg = configWithAgents({
      list: [
        { id: "sebby", sandbox: { mode: "all", workspaceAccess: "ro" } },
        { id: "buddy", sandbox: { mode: "all", workspaceAccess: "rw" } },
      ],
    });
    const policy = {
      scopes: {
        sebby: policyAgentScope(["sebby"], ["ro"]),
      },
    };

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual([]);
  });

  it("matches agent-scoped claims against normalized agent ids", async () => {
    const cfg = configWithAgents({
      list: [
        {
          id: "Sebby",
          sandbox: { mode: "all", workspaceAccess: "rw" },
          tools: { exec: { host: "node" } },
        },
      ],
    });
    const policy = {
      scopes: {
        sebby: policyAgentScope(["sebby"], ["ro"], ["sandbox"]),
      },
    };

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/sebby/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/exec/host",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/exec/allowHosts",
        }),
      ]),
    );
  });

  it("applies main agent-scoped claims to implicit default agent posture", async () => {
    const cfg = configWithPolicy({
      tools: { exec: { host: "node" } },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "rw" },
        },
        list: [
          {
            id: "support",
            sandbox: { mode: "all", workspaceAccess: "ro" },
            tools: { exec: { host: "sandbox" } },
          },
        ],
      },
    });
    const policy = {
      scopes: {
        main: policyAgentScope(["main"], ["ro"], ["sandbox"]),
      },
    };

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/main/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/host",
          requirement: "oc://policy.jsonc/scopes/main/tools/exec/allowHosts",
        }),
      ]),
    );
  });

  it("applies non-main agent-scoped claims to inherited default posture", async () => {
    const cfg = configWithPolicy({
      tools: { exec: { host: "node" } },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "rw" },
        },
        list: [
          {
            id: "support",
            sandbox: { mode: "all", workspaceAccess: "ro" },
            tools: { exec: { host: "sandbox" } },
          },
        ],
      },
    });
    const policy = {
      scopes: {
        "release-lockdown": policyAgentScope(["release-agent"], ["ro"], ["sandbox"]),
      },
    };

    const result = await runPolicyScenario(cfg, policy, "global-doctor");

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/release-lockdown/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/host",
          requirement: "oc://policy.jsonc/scopes/release-lockdown/tools/exec/allowHosts",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
        }),
      ]),
    );
  });

  it("reports sandbox posture denied by policy", async () => {
    const cfg = configWithSandbox({
      mode: "off",
      backend: "docker",
      docker: {
        network: "host",
        binds: [
          "/var/run/docker.sock:/var/run/docker.sock:rw",
          "/data:/data:rw",
          "/run/containerd/containerd.sock:/containerd.sock:ro",
          "/var/run/podman/podman.sock:/podman.sock:ro",
        ],
        seccompProfile: "unconfined",
      },
      browser: { enabled: true },
    });
    const policy = {
      sandbox: {
        requireMode: ["all", "non-main"],
        allowBackends: ["ssh"],
        containers: {
          denyHostNetwork: true,
          denyContainerNamespaceJoin: true,
          requireReadOnlyMounts: true,
          denyContainerRuntimeSocketMounts: true,
          denyUnconfinedProfiles: true,
        },
        browser: { requireCdpSourceRange: true },
      },
    };

    const result = await runPolicyScenario(cfg, policy, "checks");

    expect(result.findings.map((finding) => finding.checkId)).toEqual([
      "policy/sandbox-mode-unapproved",
      "policy/sandbox-backend-unapproved",
      "policy/sandbox-container-host-network-denied",
      "policy/sandbox-container-mount-mode-required",
      "policy/sandbox-container-mount-mode-required",
      "policy/sandbox-container-runtime-socket-mount",
      "policy/sandbox-container-runtime-socket-mount",
      "policy/sandbox-container-runtime-socket-mount",
      "policy/sandbox-container-unconfined-profile",
      "policy/sandbox-browser-cdp-source-range-missing",
    ]);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-mode-unapproved",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
          requirement: "oc://policy.jsonc/sandbox/requireMode",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
          requirement: "oc://policy.jsonc/sandbox/containers/denyContainerRuntimeSocketMounts",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#2",
          requirement: "oc://policy.jsonc/sandbox/containers/denyContainerRuntimeSocketMounts",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#3",
          requirement: "oc://policy.jsonc/sandbox/containers/denyContainerRuntimeSocketMounts",
        }),
      ]),
    );
  });

  it("keeps read-only Windows binds with drive-letter destinations compliant", async () => {
    const cfg = configWithSandbox({
      mode: "all",
      backend: "docker",
      docker: {
        binds: ["C:\\Users\\foo:C:\\container:ro"],
        network: "none",
      },
    });
    const policy = {
      sandbox: {
        containers: {
          requireReadOnlyMounts: true,
        },
      },
    };

    const result = await runPolicyScenario(cfg, policy, "checks");

    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-mount-mode-required",
        }),
      ]),
    );
  });

  it("applies sandbox bind policy to browser-specific binds", async () => {
    const cfg = configWithSandbox({
      mode: "all",
      backend: "docker",
      docker: {
        network: "none",
        binds: ["/safe:/safe:ro"],
      },
      browser: {
        enabled: true,
        cdpSourceRange: "172.21.0.1/32",
        network: "host",
        binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
      },
    });
    const policy = {
      sandbox: {
        requireMode: ["all"],
        allowBackends: ["docker"],
        containers: {
          denyHostNetwork: true,
          requireReadOnlyMounts: true,
          denyContainerRuntimeSocketMounts: true,
        },
        browser: { requireCdpSourceRange: true },
      },
    };

    const result = await runPolicyScenario(cfg, policy, "checks");
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerMount",
          bindSurface: "browser",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/binds/#0",
        }),
        expect.objectContaining({
          kind: "containerNetwork",
          value: "host",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/network",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-host-network-denied",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/browser/network",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-mount-mode-required",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/browser/binds/#0",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/browser/binds/#0",
        }),
      ]),
    );
  });

  it("does not require read-only mounts when the policy disables the rule", async () => {
    const cfg = configWithSandbox({
      mode: "all",
      backend: "docker",
      docker: {
        binds: ["/safe:/safe:ro"],
      },
    });
    const policy = {
      sandbox: {
        containers: {
          requireReadOnlyMounts: false,
        },
      },
    };

    const result = await runPolicyScenario(cfg, policy, "checks");

    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/sandbox-container-mount-mode-required" }),
      ]),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
