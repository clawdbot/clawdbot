import fs from "node:fs/promises";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_CONFIG_KEYS,
  CODEX_APP_SERVER_EXPERIMENTAL_CONFIG_KEYS,
  CODEX_COMPUTER_USE_CONFIG_KEYS,
  CODEX_PLUGIN_ENTRY_CONFIG_KEYS,
  CODEX_PLUGINS_CONFIG_KEYS,
  codexAppServerStartOptionsKey,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  resolveOpenClawExecModeForCodexAppServer,
  resolveOpenClawExecModeFromConfig,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexPluginsPolicy,
  shouldAutoApproveCodexAppServerApprovals,
} from "./config.js";

type RuntimeOptionsParams = NonNullable<Parameters<typeof resolveCodexAppServerRuntimeOptions>[0]>;

function resolveRuntimeForTest(params: RuntimeOptionsParams = {}) {
  return resolveCodexAppServerRuntimeOptions({ env: {}, requirementsToml: null, ...params });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectFields(
  value: unknown,
  label: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
  return record;
}

function expectRuntimePolicy(
  runtime: unknown,
  fields: {
    approvalPolicy: string;
    sandbox: string;
    approvalsReviewer: string;
  },
) {
  expectFields(runtime, "runtime policy", fields);
}

function expectUiHintLabel(manifest: { uiHints: Record<string, unknown> }, key: string) {
  const hint = requireRecord(manifest.uiHints[key], `${key} UI hint`);
  expect(typeof hint.label).toBe("string");
  expect((hint.label as string).length).toBeGreaterThan(0);
}

describe("Codex app-server config", () => {
  it("only auto-approves app-server approvals for full yolo runtime policy", () => {
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    ).toBe(true);
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        approvalPolicy: "never",
        sandbox: "workspace-write",
      }),
    ).toBe(false);
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
      }),
    ).toBe(false);
  });

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
          codeModeOnly: true,
          turnCompletionIdleTimeoutMs: 120_000,
          postToolRawAssistantCompletionIdleTimeoutMs: 180_000,
        },
      },
      env: {
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
      },
    });

    expectFields(runtime, "runtime", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "guardian_subagent",
      serviceTier: "flex",
      codeModeOnly: true,
      turnCompletionIdleTimeoutMs: 120_000,
      postToolRawAssistantCompletionIdleTimeoutMs: 180_000,
    });
    expectFields(runtime.start, "runtime start", {
      transport: "websocket",
      url: "ws://127.0.0.1:39175",
      headers: { "X-Test": "yes" },
    });
  });

  it("clamps oversized app-server timer config", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          requestTimeoutMs: Number.MAX_SAFE_INTEGER,
          turnCompletionIdleTimeoutMs: Number.MAX_SAFE_INTEGER,
          postToolRawAssistantCompletionIdleTimeoutMs: Number.MAX_SAFE_INTEGER,
        },
      },
    });

    expectFields(runtime, "runtime", {
      requestTimeoutMs: MAX_TIMER_TIMEOUT_MS,
      turnCompletionIdleTimeoutMs: MAX_TIMER_TIMEOUT_MS,
      postToolRawAssistantCompletionIdleTimeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
  });

  it("falls back for non-positive app-server timer config", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          requestTimeoutMs: 0,
          turnCompletionIdleTimeoutMs: -1,
        },
      },
    });

    expectFields(runtime, "runtime", {
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 60_000,
    });
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

    expectFields(runtime.start, "runtime start", {
      clearEnv: ["OPENAI_API_KEY"],
    });
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

    expectFields(runtime, "runtime", {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      approvalsReviewer: "auto_review",
      serviceTier: "priority",
    });
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

  it("rejects unknown app-server fields", () => {
    expect(
      readCodexPluginConfig({
        appServer: {
          postToolRawAssistantCompletionIdleTimeoutMs: 180_000,
          unknownTimeoutMs: 1,
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

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    expect(runtime.codeModeOnly).toBe(false);
    expectFields(runtime.start, "runtime start", {
      command: "codex",
      commandSource: "managed",
    });
  });

  it("defaults native Codex approvals to guardian when requirements disallow full access", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("uses read-only sandbox for guardian defaults when requirements only allow read-only", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_sandbox_modes = ["read-only"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      approvalsReviewer: "auto_review",
    });
  });

  it("defaults native Codex approvals to guardian when requirements disallow never approval", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("selects an allowed guardian approval policy when on-request is unavailable", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_approval_policies = ["on-failure"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-failure",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("keeps native Codex approvals unchained when requirements allow never approval", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_approval_policies = ["never"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("defaults native Codex approvals to guardian when requirements disallow user reviewer", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("selects an allowed reviewer when sandbox requirements force guardian defaults", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml:
        'allowed_sandbox_modes = ["read-only", "workspace-write"]\nallowed_approvals_reviewers = ["user"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
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

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
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

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
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

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
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
    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
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
    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("keeps native Codex approvals unchained when requirements allow full access", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml:
        'allowed_sandbox_modes = ["ReadOnly", "WorkspaceWrite", "DangerFullAccess"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("keeps native Codex approvals unchained when requirements are malformed", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: "allowed_sandbox_modes = [read-only]\n",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
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

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("keeps explicit yolo mode when requirements disallow full access", () => {
    const requirementsToml = 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n';
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { mode: "yolo" } },
        requirementsToml,
      }),
      {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      },
    );
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: {},
        env: { OPENCLAW_CODEX_APP_SERVER_MODE: "yolo" },
        requirementsToml,
      }),
      {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      },
    );
  });

  it("parses dynamic tool controls", () => {
    expect(
      readCodexPluginConfig({
        codexDynamicToolsLoading: "direct",
        codexDynamicToolsExclude: ["custom_tool"],
      }),
    ).toEqual({
      codexDynamicToolsLoading: "direct",
      codexDynamicToolsExclude: ["custom_tool"],
    });
  });

  it("parses app-server experimental flags", () => {
    expect(
      readCodexPluginConfig({
        appServer: {
          experimental: {
            sandboxExecServer: true,
          },
        },
      }).appServer?.experimental,
    ).toEqual({ sandboxExecServer: true });
  });

  it("rejects the retired dynamic tool profile key", () => {
    expect(
      readCodexPluginConfig({
        codexDynamicToolsProfile: "openclaw-compat",
        codexDynamicToolsLoading: "direct",
      }),
    ).toEqual({});
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

  it("defaults native Codex plugin destructive policy to enabled", () => {
    const policy = resolveCodexPluginsPolicy({
      codexPlugins: {
        enabled: true,
        plugins: {
          slack: {
            marketplaceName: "openai-curated",
            pluginName: "slack",
          },
        },
      },
    });

    expect(policy).toEqual({
      configured: true,
      enabled: true,
      allowDestructiveActions: true,
      pluginPolicies: [
        {
          configKey: "slack",
          marketplaceName: "openai-curated",
          pluginName: "slack",
          enabled: true,
          allowDestructiveActions: true,
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

  it("accepts native plugin identities from every first-party OpenAI marketplace", () => {
    // OpenAI ships first-party Codex plugins across three marketplaces: the local
    // openai-bundled marketplace shipped with Codex.app (chrome, browser, computer-use,
    // latex-tectonic), the remote openai-curated marketplace, and the
    // openai-primary-runtime marketplace owned by the Codex primary runtime
    // (documents, spreadsheets, presentations). All three should resolve.
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        plugins: {
          chrome: {
            marketplaceName: "openai-bundled",
            pluginName: "chrome",
          },
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
          documents: {
            marketplaceName: "openai-primary-runtime",
            pluginName: "documents",
          },
        },
      },
    });

    expect(config.codexPlugins?.enabled).toBe(true);
    const policy = resolveCodexPluginsPolicy(config);
    expect(policy.pluginPolicies).toEqual([
      {
        configKey: "chrome",
        marketplaceName: "openai-bundled",
        pluginName: "chrome",
        enabled: true,
        allowDestructiveActions: true,
      },
      {
        configKey: "documents",
        marketplaceName: "openai-primary-runtime",
        pluginName: "documents",
        enabled: true,
        allowDestructiveActions: true,
      },
      {
        configKey: "google-calendar",
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
        enabled: true,
        allowDestructiveActions: true,
      },
    ]);
  });

  it("treats configured and environment commands as explicit overrides", () => {
    expectFields(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { command: "/opt/codex/bin/codex" } },
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
      "configured start",
      {
        command: "/opt/codex/bin/codex",
        commandSource: "config",
      },
    );

    expectFields(
      resolveRuntimeForTest({
        pluginConfig: {},
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
      "environment start",
      {
        command: "/usr/local/bin/codex",
        commandSource: "env",
      },
    );
  });

  it("rejects Codex app-server command overrides that include inline arguments", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            command:
              "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
          },
        },
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.command must be only the Codex app-server executable path",
    );
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {},
        env: {
          OPENCLAW_CODEX_APP_SERVER_BIN:
            "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        },
      }),
    ).toThrow("OPENCLAW_CODEX_APP_SERVER_BIN must be only the Codex app-server executable path");
  });

  it("preserves executable paths that contain spaces", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: { appServer: { command: "C:\\Program Files\\OpenAI Codex\\codex.exe" } },
      env: {},
    });

    expect(runtime.start.command).toBe("C:\\Program Files\\OpenAI Codex\\codex.exe");
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

    expectFields(
      resolveCodexComputerUseConfig({
        pluginConfig: {},
        env: {
          OPENCLAW_CODEX_COMPUTER_USE: "1",
          OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_SOURCE: "github:example/plugins",
          OPENCLAW_CODEX_COMPUTER_USE_AUTO_INSTALL: "true",
          OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS: "30000",
        },
      }),
      "computer use config",
      {
        enabled: true,
        autoInstall: true,
        marketplaceDiscoveryTimeoutMs: 30_000,
        marketplaceSource: "github:example/plugins",
      },
    );

    for (const value of ["0x10", "1e3"]) {
      expectFields(
        resolveCodexComputerUseConfig({
          pluginConfig: {},
          env: {
            OPENCLAW_CODEX_COMPUTER_USE: "1",
            OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS: value,
          },
        }),
        "computer use config",
        {
          enabled: true,
          marketplaceDiscoveryTimeoutMs: 60_000,
        },
      );
    }
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

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("allows environment mode fallback to opt in to guardian-reviewed local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      env: { OPENCLAW_CODEX_APP_SERVER_MODE: "guardian" },
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("maps normalized OpenClaw auto exec mode to guardian-reviewed local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("forces guarded app-server policy fields for auto mode", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          approvalsReviewer: "user",
        },
      },
      env: {
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "danger-full-access",
      },
      execMode: "auto",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("preserves explicit read-only app-server sandbox for auto mode", () => {
    const configRuntime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "read-only",
          approvalsReviewer: "user",
        },
      },
      execMode: "auto",
      env: {},
    });
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
      env: {
        OPENCLAW_CODEX_APP_SERVER_MODE: "yolo",
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
      },
    });

    expectRuntimePolicy(configRuntime, {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      approvalsReviewer: "auto_review",
    });
    expectRuntimePolicy(envRuntime, {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      approvalsReviewer: "auto_review",
    });
  });

  it.each(["deny", "allowlist"] as const)(
    "blocks Codex app-server local execution for normalized OpenClaw %s exec mode",
    (execMode) => {
      expect(() =>
        resolveRuntimeForTest({
          pluginConfig: {},
          execMode,
        }),
      ).toThrow(
        `Codex app-server local execution is not available when tools.exec.mode=${execMode}`,
      );
    },
  );

  it("maps normalized OpenClaw ask exec mode away from Codex yolo", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "ask",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
  });

  it("keeps user approvals for ask mode with explicit legacy guardian mode", () => {
    const configRuntime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
      execMode: "ask",
      env: {},
    });
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "ask",
      env: { OPENCLAW_CODEX_APP_SERVER_MODE: "guardian" },
    });

    expectRuntimePolicy(configRuntime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
    expectRuntimePolicy(envRuntime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
  });

  it("overrides explicit app-server policy fields for ask mode", () => {
    const configRuntime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          approvalsReviewer: "auto_review",
        },
      },
      execMode: "ask",
      env: {},
    });
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "ask",
      env: {
        OPENCLAW_CODEX_APP_SERVER_MODE: "yolo",
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "danger-full-access",
      },
    });

    expectRuntimePolicy(configRuntime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
    expectRuntimePolicy(envRuntime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
  });

  it("preserves explicit read-only app-server sandbox for ask mode", () => {
    const configRuntime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "yolo",
          approvalPolicy: "never",
          sandbox: "read-only",
          approvalsReviewer: "auto_review",
        },
      },
      execMode: "ask",
      env: {},
    });
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "ask",
      env: {
        OPENCLAW_CODEX_APP_SERVER_MODE: "yolo",
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
      },
    });

    expectRuntimePolicy(configRuntime, {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    expectRuntimePolicy(envRuntime, {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
  });

  it("fails closed when normalized OpenClaw ask mode cannot use user approvals", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {},
        execMode: "ask",
        requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
      }),
    ).toThrow("tools.exec.mode=ask requires Codex app-server user approvals");
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: { appServer: { mode: "guardian" } },
        execMode: "ask",
        requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
      }),
    ).toThrow("tools.exec.mode=ask requires Codex app-server user approvals");
  });

  it.each([
    { execMode: "auto", policies: ["never"] },
    { execMode: "auto", policies: ["on-failure"] },
    { execMode: "auto", policies: ["untrusted"] },
    { execMode: "ask", policies: ["never"] },
    { execMode: "ask", policies: ["on-failure"] },
    { execMode: "ask", policies: ["untrusted"] },
  ] as const)(
    "fails closed when normalized OpenClaw $execMode mode can only use $policies approvals",
    ({ execMode, policies }) => {
      expect(() =>
        resolveRuntimeForTest({
          pluginConfig: {},
          execMode,
          requirementsToml: `allowed_approval_policies = [${policies
            .map((policy) => `"${policy}"`)
            .join(", ")}]\n`,
        }),
      ).toThrow(`tools.exec.mode=${execMode} requires Codex app-server prompting approvals`);
    },
  );

  it("keeps normalized OpenClaw full exec mode on default Codex yolo", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "full",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("fails closed when normalized OpenClaw auto mode can only use on-failure approvals", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {},
        execMode: "auto",
        requirementsToml:
          'allowed_sandbox_modes = ["read-only"]\nallowed_approval_policies = ["on-failure"]\nallowed_approvals_reviewers = ["user"]\n',
      }),
    ).toThrow("tools.exec.mode=auto requires Codex app-server prompting approvals");
  });

  it("fails closed when normalized OpenClaw auto mode cannot force prompting over yolo", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {},
        execMode: "auto",
        requirementsToml:
          'allowed_sandbox_modes = ["danger-full-access", "read-only"]\nallowed_approval_policies = ["never", "on-failure"]\nallowed_approvals_reviewers = ["user"]\n',
      }),
    ).toThrow("tools.exec.mode=auto requires Codex app-server prompting approvals");
  });

  it("fails closed when normalized OpenClaw auto mode cannot use an auto reviewer", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {},
        execMode: "auto",
        requirementsToml:
          'allowed_approval_policies = ["on-request"]\nallowed_approvals_reviewers = ["user"]\n',
      }),
    ).toThrow("tools.exec.mode=auto requires Codex app-server auto approvals");
  });

  it("keeps normalized OpenClaw auto mode when legacy app-server yolo was schema-defaulted", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          command: "codex",
          mode: "yolo",
          transport: "stdio",
          requestTimeoutMs: 60_000,
          turnCompletionIdleTimeoutMs: 60_000,
        },
        codexDynamicToolsLoading: "searchable",
        codexDynamicToolsExclude: [],
      },
      execMode: "auto",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
    expectFields(runtime, "runtime start", {
      start: {
        transport: "stdio",
        command: "codex",
        commandSource: "config",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      },
    });
  });

  it("forces guarded policy fields for normalized OpenClaw auto mode", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          approvalsReviewer: "user",
        },
      },
      execMode: "auto",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("resolves agent-scoped normalized OpenClaw exec mode for Codex app-server mapping", () => {
    const config = {
      tools: {
        exec: {
          mode: "ask",
        },
      },
      agents: {
        list: [
          {
            id: "Codex-Agent",
            tools: {
              exec: {
                mode: "auto",
              },
            },
          },
        ],
      },
    };

    expect(resolveOpenClawExecModeFromConfig({ config, agentId: "codex-agent" })).toBe("auto");
    expect(resolveOpenClawExecModeFromConfig({ config, agentId: "other-agent" })).toBe("ask");
  });

  it("keeps legacy exec security overrides ahead of normalized OpenClaw exec mode", () => {
    expect(
      resolveOpenClawExecModeFromConfig({
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
          agents: {
            list: [
              {
                id: "codex-agent",
                tools: {
                  exec: {
                    security: "full",
                  },
                },
              },
            ],
          },
        },
        agentId: "codex-agent",
      }),
    ).toBe("full");
  });

  it.each(["always"] as const)(
    "keeps legacy full exec security with ask=%s on prompting Codex policy",
    (ask) => {
      const config = {
        tools: {
          exec: {
            security: "full",
            ask,
          },
        },
      };
      const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({ config });

      expect(resolveOpenClawExecModeForCodexAppServer({ config })).toBe("ask");
      expectRuntimePolicy(
        resolveRuntimeForTest({
          pluginConfig: {
            appServer: {
              mode: "yolo",
              approvalPolicy: "never",
              sandbox: "workspace-write",
              approvalsReviewer: "auto_review",
            },
          },
          execPolicy,
        }),
        {
          approvalPolicy: "on-request",
          sandbox: "danger-full-access",
          approvalsReviewer: "user",
        },
      );
    },
  );

  it("keeps legacy full exec security with ask=on-miss on default Codex yolo", () => {
    const config = {
      tools: {
        exec: {
          security: "full",
          ask: "on-miss",
        },
      },
    };
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({ config });

    expect(resolveOpenClawExecModeForCodexAppServer({ config })).toBe("full");
    expectRuntimePolicy(resolveRuntimeForTest({ execPolicy }), {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("fails closed when legacy full exec with ask cannot use full Codex sandbox", () => {
    const config = {
      tools: {
        exec: {
          security: "full",
          ask: "always",
        },
      },
    };

    expect(() =>
      resolveRuntimeForTest({
        execPolicy: resolveOpenClawExecPolicyForCodexAppServer({ config }),
        requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
      }),
    ).toThrow("legacy full exec security with ask requires Codex app-server danger-full-access");
  });

  it("clamps legacy full exec with ask when an OpenClaw sandbox is active", () => {
    const config = {
      tools: {
        exec: {
          security: "full",
          ask: "always",
        },
      },
    };

    expectRuntimePolicy(
      resolveRuntimeForTest({
        execPolicy: resolveOpenClawExecPolicyForCodexAppServer({ config }),
        openClawSandboxActive: true,
        requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
      }),
      {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      },
    );
  });

  it("applies host exec approval security floors before starting Codex app-server", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      approvals: {
        version: 1,
        defaults: {
          security: "deny",
        },
        agents: {},
      },
    });

    expect(execPolicy.mode).toBe("deny");
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          },
        },
        execPolicy,
      }),
    ).toThrow("Codex app-server local execution is not available when tools.exec.mode=deny");
  });

  it("applies host exec approval ask floors before starting Codex app-server", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      approvals: {
        version: 1,
        defaults: {
          ask: "always",
        },
        agents: {},
      },
    });

    expect(execPolicy.mode).toBe("ask");
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "workspace-write",
            approvalsReviewer: "auto_review",
          },
        },
        execPolicy,
      }),
      {
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      },
    );
  });

  it("preserves explicit read-only sandbox for host exec approval ask floors", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      approvals: {
        version: 1,
        defaults: {
          ask: "always",
        },
        agents: {},
      },
    });

    expect(execPolicy.mode).toBe("ask");
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "read-only",
            approvalsReviewer: "auto_review",
          },
        },
        execPolicy,
      }),
      {
        approvalPolicy: "on-request",
        sandbox: "read-only",
        approvalsReviewer: "user",
      },
    );
  });

  it("applies agent-scoped exec approval security floors before starting Codex app-server", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      agentId: "codex-agent",
      approvals: {
        version: 1,
        defaults: {
          security: "full",
        },
        agents: {
          "codex-agent": {
            security: "deny",
          },
        },
      },
    });

    expect(execPolicy.mode).toBe("deny");
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          },
        },
        execPolicy,
      }),
    ).toThrow("Codex app-server local execution is not available when tools.exec.mode=deny");
  });

  it("applies agent-scoped exec approval ask floors before starting Codex app-server", () => {
    const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      agentId: "codex-agent",
      approvals: {
        version: 1,
        defaults: {
          ask: "off",
        },
        agents: {
          "codex-agent": {
            ask: "always",
          },
        },
      },
    });

    expect(execPolicy.mode).toBe("ask");
    expectRuntimePolicy(
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "workspace-write",
            approvalsReviewer: "auto_review",
          },
        },
        execPolicy,
      }),
      {
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      },
    );
  });

  it("treats ask-only legacy overrides as normalized mode overrides", () => {
    const config = {
      tools: {
        exec: {
          mode: "auto",
        },
      },
      agents: {
        list: [
          {
            id: "codex-agent",
            tools: {
              exec: {
                ask: "off",
              },
            },
          },
        ],
      },
    };

    expect(resolveOpenClawExecModeFromConfig({ config, agentId: "codex-agent" })).toBe("allowlist");
    const execMode = resolveOpenClawExecModeForCodexAppServer({
      config,
      agentId: "main",
      execOverrides: {
        ask: "always",
      },
    });
    expect(execMode).toBe("ask");
    expectRuntimePolicy(resolveRuntimeForTest({ execMode }), {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
  });

  it("keeps current legacy exec security overrides ahead of configured normalized mode", () => {
    const config = {
      tools: {
        exec: {
          mode: "auto",
        },
      },
    };

    expect(
      resolveOpenClawExecModeForCodexAppServer({
        config,
        agentId: "main",
        execOverrides: {
          security: "full",
        },
      }),
    ).toBe("full");
    expect(
      resolveOpenClawExecModeForCodexAppServer({
        config,
        agentId: "main",
        execOverrides: {
          ask: "always",
        },
      }),
    ).toBe("ask");
    expect(
      resolveOpenClawExecModeForCodexAppServer({
        config,
        agentId: "main",
        execOverrides: {
          security: "full",
          ask: "off",
        },
      }),
    ).toBe("full");
  });

  it("preserves legacy full exec security before applying current ask overrides", () => {
    expect(
      resolveOpenClawExecModeForCodexAppServer({
        config: {
          tools: {
            exec: {
              security: "full",
              ask: "on-miss",
            },
          },
        },
      }),
    ).toBe("full");
    expect(
      resolveOpenClawExecModeForCodexAppServer({
        config: {
          tools: {
            exec: {
              security: "full",
              ask: "always",
            },
          },
        },
        execOverrides: {
          ask: "off",
        },
      }),
    ).toBe("full");
    expect(
      resolveOpenClawExecModeForCodexAppServer({
        config: {
          tools: {
            exec: {
              security: "full",
              ask: "on-miss",
            },
          },
        },
        execOverrides: {
          ask: "off",
        },
      }),
    ).toBe("full");
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

    expectRuntimePolicy(runtime, {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
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

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-failure",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
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

  it("keeps secret-derived shared-client keys stable across module reloads", async () => {
    const startOptions = {
      transport: "websocket" as const,
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      authToken: "tok_reload",
      headers: {},
      env: { OPENAI_API_KEY: "sk-reload" },
    };
    const first = codexAppServerStartOptionsKey(startOptions);

    vi.resetModules();
    const reloaded = await import("./config.js");

    expect(reloaded.codexAppServerStartOptionsKey(startOptions)).toEqual(first);
    expect(first).not.toContain("tok_reload");
    expect(first).not.toContain("sk-reload");
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
      expectUiHintLabel(manifest, `appServer.${key}`);
    }
    const appServerExperimentalProperties = (
      manifest.configSchema.properties.appServer.properties.experimental as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(Object.keys(appServerExperimentalProperties).toSorted()).toEqual([
      ...CODEX_APP_SERVER_EXPERIMENTAL_CONFIG_KEYS,
    ]);
    for (const key of CODEX_APP_SERVER_EXPERIMENTAL_CONFIG_KEYS) {
      expectUiHintLabel(manifest, `appServer.experimental.${key}`);
    }
    const computerUseManifestKeys = Object.keys(
      manifest.configSchema.properties.computerUse.properties,
    ).toSorted();
    expect(computerUseManifestKeys).toEqual([...CODEX_COMPUTER_USE_CONFIG_KEYS].toSorted());
    for (const key of CODEX_COMPUTER_USE_CONFIG_KEYS) {
      expectUiHintLabel(manifest, `computerUse.${key}`);
    }
    const codexPluginsProperties = manifest.configSchema.properties.codexPlugins;
    const codexPluginsManifestKeys = Object.keys(codexPluginsProperties.properties).toSorted();
    expect(codexPluginsManifestKeys).toEqual([...CODEX_PLUGINS_CONFIG_KEYS].toSorted());
    expect(codexPluginsProperties.additionalProperties).toBe(false);
    for (const key of CODEX_PLUGINS_CONFIG_KEYS) {
      expectUiHintLabel(manifest, `codexPlugins.${key}`);
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

    expect(appServerProperties.mode?.default).toBeUndefined();
    expect(appServerProperties.command?.default).toBeUndefined();
    expect(appServerProperties.approvalPolicy?.default).toBeUndefined();
    expect(appServerProperties.sandbox?.default).toBeUndefined();
    expect(appServerProperties.approvalsReviewer?.default).toBeUndefined();
  });
});
