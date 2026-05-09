import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_CONFIG_KEYS,
  CODEX_COMPUTER_USE_CONFIG_KEYS,
  CODEX_PLUGIN_ENTRY_CONFIG_KEYS,
  CODEX_PLUGINS_CONFIG_KEYS,
  codexAppServerStartOptionsKey,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  resolveCodexPluginsPolicy,
} from "./config.js";

type RuntimeOptionsParams = NonNullable<Parameters<typeof resolveCodexAppServerRuntimeOptions>[0]>;

function resolveRuntimeForTest(params: RuntimeOptionsParams = {}) {
  return resolveCodexAppServerRuntimeOptions({ env: {}, requirementsToml: null, ...params });
}

describe("Codex app-server config", () => {
  it("parses typed plugin config before falling back to environment knobs", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
          headers: { "X-Test": "yes" },
          approvalPolicy: "on-request",
          sandbox: "danger-full-access",
          approvalsReviewer: "guardian_subagent",
          serviceTier: "flex",
          turnCompletionIdleTimeoutMs: 120_000,
        },
      },
      env: {
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
      },
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        approvalsReviewer: "guardian_subagent",
        serviceTier: "flex",
        turnCompletionIdleTimeoutMs: 120_000,
        start: expect.objectContaining({
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
          headers: { "X-Test": "yes" },
        }),
      }),
    );
  });

  it("ignores app-server environment clearing for websocket transports", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
          clearEnv: ["OPENAI_API_KEY"],
        },
      },
      env: {},
    });

    expect(runtime.start).not.toHaveProperty("clearEnv");
  });

  it("normalizes app-server environment variables to clear", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          clearEnv: [" OPENAI_API_KEY ", "", "  "],
        },
      },
      env: {},
    });

    expect(runtime.start).toEqual(
      expect.objectContaining({
        clearEnv: ["OPENAI_API_KEY"],
      }),
    );
  });

  it("normalizes legacy service tiers without discarding the rest of the config", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          approvalPolicy: "on-request",
          sandbox: "read-only",
          serviceTier: "fast",
        },
      },
      env: {},
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "read-only",
        approvalsReviewer: "auto_review",
        serviceTier: "priority",
      }),
    );
  });

  it("passes through non-empty Codex app-server service tiers for forward compatibility", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {
        appServer: {
          serviceTier: "batch-preview",
        },
      },
      env: {},
    });

    expect(runtime.serviceTier).toBe("batch-preview");
  });

  it("rejects malformed plugin config instead of treating freeform strings as control values", () => {
    expect(
      readCodexPluginConfig({
        appServer: {
          approvalPolicy: "always",
        },
      }),
    ).toStrictEqual({});
  });

  it("requires a websocket url when websocket transport is configured", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: { appServer: { transport: "websocket" } },
        env: {},
      }),
    ).toThrow("appServer.url is required");
  });

  it("defaults native Codex approvals to unchained local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        start: expect.objectContaining({
          command: "codex",
          commandSource: "managed",
        }),
      }),
    );
  });

  it("defaults native Codex approvals to guardian when requirements disallow full access", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("uses read-only sandbox for guardian defaults when requirements only allow read-only", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_sandbox_modes = ["read-only"]\n',
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "read-only",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("defaults native Codex approvals to guardian when requirements disallow never approval", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("selects an allowed guardian approval policy when on-request is unavailable", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_approval_policies = ["on-failure"]\n',
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-failure",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("keeps native Codex approvals unchained when requirements allow never approval", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_approval_policies = ["never"]\n',
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("defaults native Codex approvals to guardian when requirements disallow user reviewer", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("selects an allowed reviewer when sandbox requirements force guardian defaults", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml:
        'allowed_sandbox_modes = ["read-only", "workspace-write"]\nallowed_approvals_reviewers = ["user"]\n',
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      }),
    );
  });

  it("ignores quoted sandbox modes inside requirements comments", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: `allowed_sandbox_modes = [
  "read-only",
  # "danger-full-access",
  "workspace-write",
]
`,
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("applies the first matching remote sandbox requirements before resolving local stdio defaults", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      hostName: "BUILD-01.EXAMPLE.COM.",
      requirementsToml: `[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]

[[remote_sandbox_config]]
hostname_patterns = ["build-01.example.com"]
allowed_sandbox_modes = ["read-only", "danger-full-access"]
`,
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("ignores non-matching remote-only sandbox requirements when resolving local stdio defaults", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      hostName: "laptop.example.com",
      requirementsToml: `[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]
`,
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("reads local requirements policy from the configured requirements path", () => {
    const readPaths: string[] = [];
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      env: {},
      requirementsPath: "/custom/codex/requirements.toml",
      readRequirementsFile: (path) => {
        readPaths.push(path);
        return 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n';
      },
    });

    expect(readPaths).toEqual(["/custom/codex/requirements.toml"]);
    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("reads local requirements policy from the Codex Windows requirements path", () => {
    const readPaths: string[] = [];
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      env: { ProgramData: "D:\\ManagedData" },
      platform: "win32",
      readRequirementsFile: (path) => {
        readPaths.push(path);
        return 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n';
      },
    });

    expect(readPaths).toEqual(["D:\\ManagedData\\OpenAI\\Codex\\requirements.toml"]);
    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("keeps native Codex approvals unchained when requirements allow full access", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml:
        'allowed_sandbox_modes = ["ReadOnly", "WorkspaceWrite", "DangerFullAccess"]\n',
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("keeps native Codex approvals unchained when requirements are malformed", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: "allowed_sandbox_modes = [read-only]\n",
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("does not apply local requirements policy to websocket app-server transports", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
        },
      },
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("keeps explicit yolo mode when requirements disallow full access", () => {
    const requirementsToml = 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n';
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { mode: "yolo" } },
        requirementsToml,
      }),
    ).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
    expect(
      resolveRuntimeForTest({
        pluginConfig: {},
        env: { OPENCLAW_CODEX_APP_SERVER_MODE: "yolo" },
        requirementsToml,
      }),
    ).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("parses dynamic tool profile controls", () => {
    expect(
      readCodexPluginConfig({
        codexDynamicToolsProfile: "openclaw-compat",
        codexDynamicToolsLoading: "direct",
        codexDynamicToolsExclude: ["custom_tool"],
      }),
    ).toMatchObject({
      codexDynamicToolsProfile: "openclaw-compat",
      codexDynamicToolsLoading: "direct",
      codexDynamicToolsExclude: ["custom_tool"],
    });
  });

  it("parses native Codex plugin policy without treating wildcard as supported config", () => {
    const config = readCodexPluginConfig({
      appServer: { mode: "guardian" },
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: false,
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
            allow_destructive_actions: true,
          },
          slack: {
            enabled: false,
            marketplaceName: "openai-curated",
            pluginName: "slack",
          },
        },
      },
    });

    expect(config.appServer?.mode).toBe("guardian");
    expect(config.codexPlugins?.enabled).toBe(true);

    const policy = resolveCodexPluginsPolicy(config);
    expect(policy).toEqual({
      configured: true,
      enabled: true,
      allowDestructiveActions: false,
      pluginPolicies: [
        {
          configKey: "google-calendar",
          marketplaceName: "openai-curated",
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
        },
        {
          configKey: "slack",
          marketplaceName: "openai-curated",
          pluginName: "slack",
          enabled: false,
          allowDestructiveActions: false,
        },
      ],
    });
  });

  it("rejects non-curated native plugin identities", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        plugins: {
          gmail: {
            marketplaceName: "custom-market",
            pluginName: "gmail",
          },
        },
      },
    });

    expect(config.codexPlugins).toBeUndefined();
    expect(resolveCodexPluginsPolicy(config).pluginPolicies).toStrictEqual([]);
  });

  it("treats configured and environment commands as explicit overrides", () => {
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { command: "/opt/codex/bin/codex" } },
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
    ).toEqual(
      expect.objectContaining({
        command: "/opt/codex/bin/codex",
        commandSource: "config",
      }),
    );

    expect(
      resolveRuntimeForTest({
        pluginConfig: {},
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
    ).toEqual(
      expect.objectContaining({
        command: "/usr/local/bin/codex",
        commandSource: "env",
      }),
    );
  });

  it("resolves Computer Use setup from plugin config and environment fallbacks", () => {
    expect(
      resolveCodexComputerUseConfig({
        pluginConfig: {
          computerUse: {
            autoInstall: true,
            marketplaceName: "desktop-tools",
          },
        },
        env: {
          OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_NAME: "env-fallback-plugin",
        },
      }),
    ).toEqual({
      enabled: true,
      autoInstall: true,
      marketplaceDiscoveryTimeoutMs: 60_000,
      pluginName: "env-fallback-plugin",
      mcpServerName: "computer-use",
      marketplaceName: "desktop-tools",
    });

    expect(
      resolveCodexComputerUseConfig({
        pluginConfig: {},
        env: {
          OPENCLAW_CODEX_COMPUTER_USE: "1",
          OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_SOURCE: "github:example/plugins",
          OPENCLAW_CODEX_COMPUTER_USE_AUTO_INSTALL: "true",
          OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS: "30000",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        autoInstall: true,
        marketplaceDiscoveryTimeoutMs: 30_000,
        marketplaceSource: "github:example/plugins",
      }),
    );
  });

  it("allows plugin config to opt in to guardian-reviewed local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
      env: {},
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("allows environment mode fallback to opt in to guardian-reviewed local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      env: { OPENCLAW_CODEX_APP_SERVER_MODE: "guardian" },
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("accepts the latest auto_review reviewer and legacy guardian_subagent alias", () => {
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { approvalsReviewer: "auto_review" } },
        env: {},
      }).approvalsReviewer,
    ).toBe("auto_review");
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { approvalsReviewer: "guardian_subagent" } },
        env: {},
      }).approvalsReviewer,
    ).toBe("guardian_subagent");
  });

  it("ignores removed OPENCLAW_CODEX_APP_SERVER_GUARDIAN fallback", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      env: { OPENCLAW_CODEX_APP_SERVER_GUARDIAN: "1" },
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("lets explicit policy fields override guardian mode", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          approvalPolicy: "on-failure",
          sandbox: "danger-full-access",
          approvalsReviewer: "user",
        },
      },
      env: {},
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-failure",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("derives distinct shared-client keys for distinct auth tokens without exposing them", () => {
    const first = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      authToken: "tok_first",
      headers: {},
    });
    const second = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      authToken: "tok_second",
      headers: {},
    });

    expect(first).not.toEqual(second);
    expect(
      codexAppServerStartOptionsKey({
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok_first",
        headers: {},
      }),
    ).toEqual(first);
    expect(first).not.toContain("tok_first");
    expect(second).not.toContain("tok_second");
  });

  it("derives distinct shared-client keys for distinct env values without exposing them", () => {
    const first = codexAppServerStartOptionsKey({
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
      env: { OPENAI_API_KEY: "sk-first" },
    });
    const second = codexAppServerStartOptionsKey({
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
      env: { OPENAI_API_KEY: "sk-second" },
    });

    expect(first).not.toEqual(second);
    expect(
      codexAppServerStartOptionsKey({
        transport: "stdio",
        command: "codex",
        args: ["app-server"],
        headers: {},
        env: { OPENAI_API_KEY: "sk-first" },
      }),
    ).toEqual(first);
    expect(first).not.toContain("sk-first");
    expect(second).not.toContain("sk-second");
  });

  it("derives distinct shared-client keys for distinct agent dirs", () => {
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: {},
    };

    expect(codexAppServerStartOptionsKey(startOptions, { agentDir: "/tmp/agent-a" })).not.toEqual(
      codexAppServerStartOptionsKey(startOptions, { agentDir: "/tmp/agent-b" }),
    );
  });

  it("keeps runtime config keys aligned with manifest schema and UI hints", async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema: {
        properties: {
          appServer: { properties: Record<string, unknown> };
          computerUse: { properties: Record<string, unknown> };
          codexPlugins: {
            properties: Record<string, unknown>;
            additionalProperties: boolean;
          };
        };
      };
      uiHints: Record<string, unknown>;
    };
    const manifestKeys = Object.keys(
      manifest.configSchema.properties.appServer.properties,
    ).toSorted();

    expect(manifestKeys).toEqual([...CODEX_APP_SERVER_CONFIG_KEYS].toSorted());
    for (const key of CODEX_APP_SERVER_CONFIG_KEYS) {
      expect(manifest.uiHints[`appServer.${key}`]).toMatchObject({
        label: expect.any(String),
      });
    }
    const computerUseManifestKeys = Object.keys(
      manifest.configSchema.properties.computerUse.properties,
    ).toSorted();
    expect(computerUseManifestKeys).toEqual([...CODEX_COMPUTER_USE_CONFIG_KEYS].toSorted());
    for (const key of CODEX_COMPUTER_USE_CONFIG_KEYS) {
      expect(manifest.uiHints[`computerUse.${key}`]).toMatchObject({
        label: expect.any(String),
      });
    }
    const codexPluginsProperties = manifest.configSchema.properties.codexPlugins;
    const codexPluginsManifestKeys = Object.keys(codexPluginsProperties.properties).toSorted();
    expect(codexPluginsManifestKeys).toEqual([...CODEX_PLUGINS_CONFIG_KEYS].toSorted());
    expect(codexPluginsProperties.additionalProperties).toBe(false);
    for (const key of CODEX_PLUGINS_CONFIG_KEYS) {
      expect(manifest.uiHints[`codexPlugins.${key}`]).toMatchObject({
        label: expect.any(String),
      });
    }
    const pluginEntryProperties = (
      codexPluginsProperties.properties.plugins as {
        additionalProperties: { properties: Record<string, unknown> };
      }
    ).additionalProperties.properties;
    expect(Object.keys(pluginEntryProperties).toSorted()).toEqual(
      [...CODEX_PLUGIN_ENTRY_CONFIG_KEYS].toSorted(),
    );
  });

  it("does not schema-default mode-derived policy fields", async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema: {
        properties: {
          appServer: {
            properties: Record<string, { default?: unknown }>;
          };
        };
      };
    };
    const appServerProperties = manifest.configSchema.properties.appServer.properties;

    expect(appServerProperties.command?.default).toBeUndefined();
    expect(appServerProperties.approvalPolicy?.default).toBeUndefined();
    expect(appServerProperties.sandbox?.default).toBeUndefined();
    expect(appServerProperties.approvalsReviewer?.default).toBeUndefined();
  });
});
