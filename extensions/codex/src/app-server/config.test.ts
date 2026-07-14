// Codex tests cover config plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  canUseCodexModelBackedApprovalsReviewerForModel,
  codexAppServerStartOptionsKey,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
  resolveCodexAppServerUserHomeDir,
  resolveCodexSupervisionAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexPluginsPolicy,
  shouldAutoApproveCodexAppServerApprovals,
  withMcpElicitationsApprovalPolicy,
} from "./config.js";

type RuntimeOptionsParams = NonNullable<Parameters<typeof resolveCodexAppServerRuntimeOptions>[0]>;

function resolveRuntimeForTest(params: RuntimeOptionsParams = {}) {
  return resolveCodexAppServerRuntimeOptions({ env: {}, requirementsToml: null, ...params });
}

describe("withMcpElicitationsApprovalPolicy", () => {
  it("returns every field required by Codex granular approval policy", () => {
    expect(withMcpElicitationsApprovalPolicy("never")).toEqual({
      granular: {
        mcp_elicitations: true,
        request_permissions: false,
        rules: false,
        sandbox_approval: false,
        skill_approval: false,
      },
    });
  });
});

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
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
    expect(
      shouldAutoApproveCodexAppServerApprovals({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        networkProxy: {
          profileName: "openclaw-network",
          configFingerprint: "network-proxy-v1",
          configPatch: {
            "features.network_proxy.enabled": true,
            default_permissions: "openclaw-network",
            permissions: {},
          },
        },
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
      modelProvider: "openai",
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

  it("builds Codex permissions-profile config for app-server network proxy", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          sandbox: "workspace-write",
          networkProxy: {
            enabled: true,
            profileName: "mock-proxy",
            mode: "limited",
            domains: {
              " api.openai.com ": "allow",
              "blocked.example.com": "deny",
            },
            unixSockets: {
              " /tmp/mock-proxy.sock ": "allow",
              "/tmp/blocked.sock": "none",
            },
            proxyUrl: "http://127.0.0.1:3128",
            socksUrl: "socks5h://127.0.0.1:8081",
            enableSocks5: true,
            enableSocks5Udp: false,
            allowUpstreamProxy: true,
            allowLocalBinding: false,
          },
        },
      },
    });

    const networkProxy = runtime.networkProxy;
    if (!networkProxy) {
      throw new Error("Expected network proxy runtime config");
    }
    expect(networkProxy).toEqual({
      profileName: "mock-proxy",
      configFingerprint: expect.any(String),
      configPatch: {
        "features.network_proxy.enabled": true,
        default_permissions: "mock-proxy",
        permissions: {
          "mock-proxy": {
            filesystem: {
              ":minimal": "read",
              ":project_roots": {
                ".": "write",
              },
            },
            network: {
              enabled: true,
              mode: "limited",
              domains: {
                "api.openai.com": "allow",
                "blocked.example.com": "deny",
              },
              unix_sockets: {
                "/tmp/mock-proxy.sock": "allow",
                "/tmp/blocked.sock": "none",
              },
              proxy_url: "http://127.0.0.1:3128",
              socks_url: "socks5h://127.0.0.1:8081",
              enable_socks5: true,
              enable_socks5_udp: false,
              allow_upstream_proxy: true,
              allow_local_binding: false,
            },
          },
        },
      },
    });
  });

  it("uses read-only filesystem rules for read-only network proxy profiles", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          sandbox: "read-only",
          networkProxy: {
            enabled: true,
            domains: { "example.com": "allow" },
          },
        },
      },
    });
    const profileName = runtime.networkProxy?.profileName;
    const permissions = runtime.networkProxy?.configPatch.permissions as Record<
      string,
      { filesystem: { ":project_roots": { ".": string } } }
    >;

    expect(profileName).toMatch(/^openclaw-network-[a-f0-9]{16}$/u);
    expect(runtime.networkProxy?.configPatch.default_permissions).toBe(profileName);
    expect(permissions[profileName ?? ""]?.filesystem[":project_roots"]["."]).toBe("read");
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
      modelProvider: "openai",
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

  it("rejects removed app-server topology fields", () => {
    expect(
      readCodexPluginConfig({
        appServer: {
          transport: "websocket",
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "capability-token",
          connectionClass: "remote",
          remoteAppsSubstrate: "preconfigured",
          remoteWorkspace: {
            localRoot: "/Users/kevinlin/code/openclaw",
            remoteRoot: "/home/oai/openclaw-workspaces",
          },
        },
      }),
    ).toStrictEqual({});
    expect(
      readCodexPluginConfig({
        appServer: {
          remoteWorkspace: {
            localRoot: "/Users/kevinlin/code/openclaw",
            remoteRoot: "/home/oai/openclaw-workspaces",
          },
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

  it("marks authenticated non-loopback websocket app-servers as remote runtimes", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "capability-token",
          remoteWorkspaceRoot: " /home/oai/openclaw-workspaces ",
        },
      },
    });

    expectFields(runtime, "runtime", {
      connectionClass: "remote",
      remoteAppsSubstrate: "preconfigured",
      remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
    });
  });

  it("passes resolved app-server SecretInput strings through to auth token and headers", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "wss://codex-app-server.example.internal/ws",
          authToken: " resolved-capability-token ",
          headers: {
            " x-codex-client-session-token ": " resolved-session-token ",
            Authorization: " Bearer explicit-token ",
          },
        },
      },
    });

    expectFields(runtime.start, "runtime start", {
      authToken: "resolved-capability-token",
      headers: {
        "x-codex-client-session-token": "resolved-session-token",
        Authorization: "Bearer explicit-token",
      },
    });
  });

  it("rejects unresolved app-server auth token SecretRefs at runtime option resolution", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "websocket",
            url: "wss://codex-app-server.example.internal/ws",
            authToken: envRef("CODEX_APP_SERVER_TOKEN"),
          },
        },
      }),
    ).toThrow(
      'plugins.entries.codex.config.appServer.authToken: unresolved SecretRef "env:default:CODEX_APP_SERVER_TOKEN"',
    );
  });

  it("rejects unresolved app-server header SecretRefs at runtime option resolution", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "websocket",
            url: "wss://codex-app-server.example.internal/ws",
            authToken: "capability-token",
            headers: {
              "x-codex-client-session-token": envRef("CODEX_CLIENT_SESSION_TOKEN"),
            },
          },
        },
      }),
    ).toThrow(
      'plugins.entries.codex.config.appServer.headers.x-codex-client-session-token: unresolved SecretRef "env:default:CODEX_CLIENT_SESSION_TOKEN"',
    );
  });

  it("treats IPv6 loopback websocket app-servers as local loopback", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "ws://[::1]:4242",
        },
      },
    });

    expectFields(runtime, "runtime", {
      connectionClass: "local-loopback",
    });
  });

  it("rejects remote websocket app-servers without identity-bearing auth", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "websocket",
            url: "wss://codex-app-server.example.internal/ws",
          },
        },
      }),
    ).toThrow(
      "remote Codex app-server WebSocket URLs require appServer.authToken or an Authorization header",
    );
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
      homeScope: "agent",
    });
  });

  it("does not change ordinary harness connection defaults when supervision is enabled", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: { supervision: { enabled: true } },
    });

    expectFields(runtime.start, "runtime start", {
      transport: "stdio",
      homeScope: "agent",
    });
    expect(runtime.start).not.toHaveProperty("url");
  });

  it("uses shared user-home defaults only for supervision control connections", () => {
    const runtime = resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: { supervision: { enabled: true } },
      env: {},
      requirementsToml: null,
    });

    expectFields(runtime.start, "runtime start", {
      transport: "stdio",
      homeScope: "user",
    });
    expect(runtime.start).not.toHaveProperty("url");
  });

  it("honors explicit app-server settings for supervision control connections", () => {
    const runtime = resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: {
        supervision: { enabled: true },
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
        },
      },
      env: {},
      requirementsToml: null,
    });

    expectFields(runtime.start, "runtime start", {
      transport: "websocket",
      homeScope: "agent",
      url: "ws://127.0.0.1:39175",
    });
  });

  it("honors explicit app-server connection settings when supervision is enabled", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        supervision: { enabled: true },
        appServer: {
          transport: "websocket",
          homeScope: "agent",
          url: "ws://127.0.0.1:39175",
        },
      },
    });

    expectFields(runtime.start, "runtime start", {
      transport: "websocket",
      homeScope: "agent",
      url: "ws://127.0.0.1:39175",
    });
  });

  it("rejects Unix app-server connections outside the shared user home", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "unix",
            homeScope: "agent",
          },
        },
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.transport=unix requires appServer.homeScope=user",
    );
  });

  it("rejects non-Unix URLs for Unix app-server connections", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "unix",
            homeScope: "user",
            url: "ws://127.0.0.1:39175",
          },
        },
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.url must use unix:// when appServer.transport is unix",
    );
  });

  it("resolves opt-in user-home coexistence only for local stdio", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: { appServer: { homeScope: "user" } },
    });

    expect(runtime.start.homeScope).toBe("user");
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            transport: "websocket",
            url: "ws://127.0.0.1:39175",
            homeScope: "user",
          },
        },
      }),
    ).toThrow(
      "plugins.entries.codex.config.appServer.homeScope=user requires appServer.transport=stdio or unix",
    );
  });

  it("resolves the native user Codex home from CODEX_HOME or the OS home", () => {
    expect(resolveCodexAppServerUserHomeDir({ CODEX_HOME: "/tmp/custom-codex" })).toBe(
      "/tmp/custom-codex",
    );
    expect(resolveCodexAppServerUserHomeDir({}, () => "/Users/tester")).toBe(
      "/Users/tester/.codex",
    );
  });

  it("checks shared user config before enabling model-backed approval review", async () => {
    await withTempDir("openclaw-codex-user-home-", async (codexHome) => {
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        'openai_base_url = "http://localhost:8080/v1"\n',
      );

      expect(
        canUseCodexModelBackedApprovalsReviewerForModel({
          modelProvider: "openai",
          model: "gpt-5.5",
          env: { CODEX_HOME: codexHome },
          homeScope: "user",
        }),
      ).toBe(false);
    });
  });

  it("treats only explicit OpenAI model context as safe for Codex-backed auto-review", () => {
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
      }),
    ).toBe(true);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "codex",
        model: "openai/gpt-5.5",
      }),
    ).toBe(true);
    expect(canUseCodexModelBackedApprovalsReviewerForModel({})).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "codex",
        model: "gpt-5.5",
      }),
    ).toBe(false);
    for (const codexConfigToml of [
      'openai_base_url = """http://localhost:8080/v1"""\n',
      "openai_base_url = '''http://localhost:8080/v1'''\n",
      'chatgpt_base_url = """http://localhost:8080/backend-api"""\n',
      "[model_providers.openai]\nbase_url = '''http://localhost:8080/v1'''\n",
    ]) {
      expect(
        canUseCodexModelBackedApprovalsReviewerForModel({
          modelProvider: "openai",
          model: "gpt-5.5",
          codexConfigToml,
        }),
      ).toBe(false);
    }
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openrouter",
        model: "openai/gpt-5.5",
      }),
    ).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "lmstudio/local-model",
      }),
    ).toBe(false);
    const switchedLocalModel = resolveCodexModelBackedReviewerPolicyContext({
      model: "lmstudio/local-model",
      bindingModel: "gpt-5.5",
      nativeAuthProfile: true,
    });
    expect(switchedLocalModel).toEqual({
      modelProvider: "lmstudio",
      model: "lmstudio/local-model",
    });
    expect(canUseCodexModelBackedApprovalsReviewerForModel(switchedLocalModel)).toBe(false);
    const switchedOpenAIModel = resolveCodexModelBackedReviewerPolicyContext({
      provider: "codex",
      model: "openai/gpt-5.5",
      bindingModel: "local-model",
      bindingModelProvider: "lmstudio",
    });
    expect(switchedOpenAIModel).toEqual({
      modelProvider: "openai",
      model: "openai/gpt-5.5",
    });
    expect(canUseCodexModelBackedApprovalsReviewerForModel(switchedOpenAIModel)).toBe(true);
    const legacyBindingOpenAIModel = resolveCodexModelBackedReviewerPolicyContext({
      provider: "codex",
      model: "openai/gpt-5.5",
      bindingModelProvider: "lmstudio",
    });
    expect(legacyBindingOpenAIModel).toEqual({
      modelProvider: "openai",
      model: "openai/gpt-5.5",
    });
    expect(canUseCodexModelBackedApprovalsReviewerForModel(legacyBindingOpenAIModel)).toBe(true);
    const boundLocalOpenAIName = resolveCodexModelBackedReviewerPolicyContext({
      provider: "codex",
      model: "openai/gpt-oss-20b",
      bindingModel: "openai/gpt-oss-20b",
      bindingModelProvider: "lmstudio",
    });
    expect(boundLocalOpenAIName).toEqual({
      modelProvider: "lmstudio",
      model: "openai/gpt-oss-20b",
    });
    expect(canUseCodexModelBackedApprovalsReviewerForModel(boundLocalOpenAIName)).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        codexConfigToml: 'openai_base_url = "https://api.openai.com/v1"\n',
      }),
    ).toBe(true);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        codexConfigToml: 'openai_base_url = "http://localhost:8080/v1"\n',
      }),
    ).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        codexConfigToml: '[model_providers.openai]\nbase_url = "http://localhost:8080/v1"\n',
      }),
    ).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        codexConfigToml: 'model_providers.openai.base_url = "http://localhost:8080/v1"\n',
      }),
    ).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        codexConfigToml:
          'model_providers = { openai = { base_url = "http://localhost:8080/v1" } }\n',
      }),
    ).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        codexConfigToml: 'chatgpt_base_url = "https://chatgpt.com/backend-api/"\n',
      }),
    ).toBe(true);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        codexConfigToml: 'chatgpt_base_url = "http://localhost:8080/backend-api"\n',
      }),
    ).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://localhost:8080/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(false);
    for (const openAIProvider of [
      {
        baseUrl: "https://api.openai.com/v1",
        request: { proxy: { mode: "explicit-proxy" as const, url: "http://localhost:8080" } },
        models: [],
      },
      {
        baseUrl: "https://api.openai.com/v1",
        headers: { "x-openclaw-reviewer-proxy": "local" },
        models: [],
      },
      {
        baseUrl: "https://api.openai.com/v1",
        authHeader: false,
        models: [],
      },
      {
        baseUrl: "https://api.openai.com/v1",
        models: [
          {
            id: "gpt-5.5",
            name: "GPT with custom headers",
            reasoning: true,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
            headers: { "x-openclaw-reviewer-proxy": "local" },
          },
        ],
      },
    ]) {
      expect(
        canUseCodexModelBackedApprovalsReviewerForModel({
          modelProvider: "openai",
          model: "gpt-5.5",
          config: {
            models: {
              providers: {
                openai: openAIProvider,
              },
            },
          },
        }),
      ).toBe(false);
    }
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        env: {
          OPENAI_BASE_URL: "http://localhost:8080/v1",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
    expect(
      canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: "openai",
        model: "gpt-5.5",
        env: {
          OPENAI_BASE_URL: "",
          OPENAI_API_BASE: "http://localhost:8080/v1",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("uses user approvals when Codex native OpenAI config is local", () => {
    const runtime = resolveRuntimeForTest({
      execMode: "auto",
      modelProvider: "openai",
      model: "gpt-5.5",
      codexConfigToml: 'openai_base_url = "http://localhost:8080/v1"\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
  });

  it("forces prompting when explicit no-prompt config cannot use model-backed review", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          approvalsReviewer: "auto_review",
        },
      },
      modelProvider: "lmstudio",
      model: "local-model",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
    expect(shouldAutoApproveCodexAppServerApprovals(runtime)).toBe(false);
  });

  it("uses user approvals when requirements force prompting but model provider is unknown", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
  });

  it("defaults native OpenAI Codex approvals to guardian when requirements disallow full access", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
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
      modelProvider: "openai",
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
      modelProvider: "openai",
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("normalizes the deprecated requirements on-failure alias to on-request", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
      requirementsToml: 'allowed_approval_policies = ["on-failure"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
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
      modelProvider: "openai",
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
      modelProvider: "openai",
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
      modelProvider: "openai",
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
      modelProvider: "openai",
      requirementsPath: "/custom/codex/requirements.toml",
      readRequirementsFile: (requirementsPath) => {
        readPaths.push(requirementsPath);
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
      modelProvider: "openai",
      platform: "win32",
      readRequirementsFile: (requirementsPath) => {
        readPaths.push(requirementsPath);
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
      allowAllPlugins: false,
      allowDestructiveActions: false,
      destructiveApprovalMode: "deny",
      pluginPolicies: [
        {
          configKey: "google-calendar",
          marketplaceName: "openai-curated",
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "allow",
        },
        {
          configKey: "slack",
          marketplaceName: "openai-curated",
          pluginName: "slack",
          enabled: false,
          allowDestructiveActions: false,
          destructiveApprovalMode: "deny",
        },
      ],
    });
  });

  it("parses auto native Codex plugin destructive policy", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
          slack: {
            marketplaceName: "openai-curated",
            pluginName: "slack",
            allow_destructive_actions: false,
          },
          gmail: {
            marketplaceName: "openai-curated",
            pluginName: "gmail",
            allow_destructive_actions: true,
          },
        },
      },
    });

    expect(config.codexPlugins?.allow_destructive_actions).toBe("auto");
    expect(resolveCodexPluginsPolicy(config)).toEqual({
      configured: true,
      enabled: true,
      allowAllPlugins: false,
      allowDestructiveActions: true,
      destructiveApprovalMode: "auto",
      pluginPolicies: [
        {
          configKey: "gmail",
          marketplaceName: "openai-curated",
          pluginName: "gmail",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "allow",
        },
        {
          configKey: "google-calendar",
          marketplaceName: "openai-curated",
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "auto",
        },
        {
          configKey: "slack",
          marketplaceName: "openai-curated",
          pluginName: "slack",
          enabled: true,
          allowDestructiveActions: false,
          destructiveApprovalMode: "deny",
        },
      ],
    });
  });

  it("parses ask native Codex plugin destructive policy", () => {
    const config = readCodexPluginConfig({
      appServer: { mode: "guardian" },
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "ask",
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
          slack: {
            marketplaceName: "openai-curated",
            pluginName: "slack",
            allow_destructive_actions: "auto",
          },
        },
      },
    });

    expect(config.appServer?.mode).toBe("guardian");
    expect(config.codexPlugins?.allow_destructive_actions).toBe("ask");
    expect(resolveCodexPluginsPolicy(config)).toEqual({
      configured: true,
      enabled: true,
      allowAllPlugins: false,
      allowDestructiveActions: true,
      destructiveApprovalMode: "ask",
      pluginPolicies: [
        {
          configKey: "google-calendar",
          marketplaceName: "openai-curated",
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask",
        },
        {
          configKey: "slack",
          marketplaceName: "openai-curated",
          pluginName: "slack",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "auto",
        },
      ],
    });
  });

  it("rejects unsupported native Codex plugin destructive policy strings", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "always",
        plugins: {
          slack: {
            marketplaceName: "openai-curated",
            pluginName: "slack",
          },
        },
      },
    });

    expect(config.codexPlugins).toBeUndefined();
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
      allowAllPlugins: false,
      allowDestructiveActions: true,
      destructiveApprovalMode: "allow",
      pluginPolicies: [
        {
          configKey: "slack",
          marketplaceName: "openai-curated",
          pluginName: "slack",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "allow",
        },
      ],
    });
  });

  it("parses workspace-directory native plugin identities", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        plugins: {
          workspaceData: {
            marketplaceName: "workspace-directory",
            pluginName: "workspace-data@workspace-directory",
            allow_destructive_actions: "ask",
          },
        },
      },
    });

    expect(resolveCodexPluginsPolicy(config).pluginPolicies).toStrictEqual([
      {
        configKey: "workspaceData",
        marketplaceName: "workspace-directory",
        pluginName: "workspace-data@workspace-directory",
        enabled: true,
        allowDestructiveActions: true,
        destructiveApprovalMode: "ask",
      },
    ]);
  });

  it("rejects unsupported native plugin identities", () => {
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

  it("parses opt-in access to all connected account apps", () => {
    const config = readCodexPluginConfig({
      codexPlugins: {
        enabled: true,
        allow_all_plugins: true,
        allow_destructive_actions: "auto",
      },
    });

    expect(config.codexPlugins).toEqual({
      enabled: true,
      allow_all_plugins: true,
      allow_destructive_actions: "auto",
    });
    expect(resolveCodexPluginsPolicy(config)).toEqual({
      configured: true,
      enabled: true,
      allowAllPlugins: true,
      allowDestructiveActions: true,
      destructiveApprovalMode: "auto",
      pluginPolicies: [],
    });
  });

  it("requires native plugin support before exposing all connected account apps", () => {
    expect(resolveCodexPluginsPolicy({ codexPlugins: { allow_all_plugins: true } })).toEqual({
      configured: true,
      enabled: false,
      allowAllPlugins: false,
      allowDestructiveActions: true,
      destructiveApprovalMode: "allow",
      pluginPolicies: [],
    });
    expect(
      readCodexPluginConfig({ codexPlugins: { enabled: true, allow_all_plugins: "yes" } }),
    ).toEqual({});
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

  it("uses the pinned managed package for ordinary turns and desktop ownership for Computer Use", () => {
    expect(resolveRuntimeForTest({ pluginConfig: {} }).start.managedCommandOrder).toBeUndefined();
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { homeScope: "user" } },
      }).start.managedCommandOrder,
    ).toBe("desktop-first");
    expect(
      resolveRuntimeForTest({
        pluginConfig: { computerUse: { enabled: true } },
      }).start.managedCommandOrder,
    ).toBe("desktop-first");
    expect(
      resolveRuntimeForTest({
        pluginConfig: {},
        managedCommandOrder: "desktop-first",
      }).start.managedCommandOrder,
    ).toBe("desktop-first");
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { homeScope: "user" } },
        managedCommandOrder: "package-first",
      }).start.managedCommandOrder,
    ).toBe("package-first");
  });

  it("reads effective native Computer Use state before managed spawn", () => {
    const startOptions = resolveRuntimeForTest({ pluginConfig: {} }).start;
    const resolveForConfig = (codexConfigToml: string) =>
      resolveCodexAppServerStartOptionsForAgent({
        startOptions,
        agentDir: "/tmp/openclaw-agent",
        codexConfigToml,
      }).managedCommandOrder;

    expect(
      resolveForConfig('[plugins."computer-use@openai-bundled"]\nenabled = false\n'),
    ).toBeUndefined();
    for (const codexConfigToml of [
      '[plugins."computer-use@openai-bundled"]\n',
      'plugins."computer-use@openai-bundled".enabled = true\n',
      'plugins = { "computer-use@openai-bundled" = { enabled = true } }\n',
      '["plugins"."computer-use@openai-bundled".mcp_servers.computer_use]\n',
    ]) {
      expect(resolveForConfig(codexConfigToml)).toBe("desktop-first");
    }
    expect(
      resolveForConfig(
        'model_context_window = 9223372036854775807\ndeveloper_instructions = """\n[plugins."computer-use@openai-bundled"]\nenabled = true\n"""\n',
      ),
    ).toBeUndefined();
    expect(resolveForConfig("[plugins.invalid")).toBe("desktop-first");

    const customIdentityStartOptions = resolveRuntimeForTest({
      pluginConfig: { computerUse: { pluginName: "custom-computer-use" } },
    }).start;
    expect(customIdentityStartOptions.managedCommandOrder).toBe("desktop-first");
    expect(customIdentityStartOptions.managedComputerUsePluginNames).toEqual([
      "computer-use",
      "custom-computer-use",
    ]);
    expect(
      resolveCodexAppServerStartOptionsForAgent({
        startOptions: customIdentityStartOptions,
        agentDir: "/tmp/openclaw-agent",
        codexConfigToml: '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      }).managedCommandOrder,
    ).toBe("desktop-first");
    expect(
      resolveCodexAppServerStartOptionsForAgent({
        startOptions: customIdentityStartOptions,
        agentDir: "/tmp/openclaw-agent",
        codexConfigToml:
          '[plugins."computer-use@openai-bundled"]\nenabled = false\n[plugins."custom-computer-use@local"]\nenabled = true\n',
      }).managedCommandOrder,
    ).toBe("desktop-first");

    const privateStartOptions = resolveRuntimeForTest({
      pluginConfig: { appServer: { homeScope: "user" } },
      managedCommandOrder: "package-first",
    }).start;
    expect(
      resolveCodexAppServerStartOptionsForAgent({
        startOptions: privateStartOptions,
        agentDir: "/tmp/openclaw-agent",
        codexConfigToml: '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      }).managedCommandOrder,
    ).toBe("package-first");
  });

  it("keeps desktop ownership for Computer Use persisted in an agent Codex home", async () => {
    await withTempDir("openclaw-codex-agent-home-", async (agentDir) => {
      const startOptions = resolveRuntimeForTest({ pluginConfig: {} }).start;
      const codexHome = path.join(agentDir, "codex-home");
      await fs.mkdir(codexHome);
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );

      expect(
        resolveCodexAppServerStartOptionsForAgent({
          startOptions,
          agentDir,
        }).managedCommandOrder,
      ).toBe("desktop-first");
    });
  });

  it("uses desktop-first when persisted Codex state cannot be read", async () => {
    await withTempDir("openclaw-codex-unreadable-home-", async (agentDir) => {
      const startOptions = resolveRuntimeForTest({ pluginConfig: {} }).start;
      await fs.mkdir(path.join(agentDir, "codex-home"), { recursive: true });
      await fs.mkdir(path.join(agentDir, "codex-home", "config.toml"));

      expect(
        resolveCodexAppServerStartOptionsForAgent({
          startOptions,
          agentDir,
        }).managedCommandOrder,
      ).toBe("desktop-first");
    });
  });

  it("does not change explicit commands when Computer Use is enabled", () => {
    const start = resolveRuntimeForTest({
      pluginConfig: {
        appServer: { command: "/opt/codex/bin/codex" },
        computerUse: { enabled: true },
      },
    }).start;

    expectFields(start, "configured Computer Use start", {
      command: "/opt/codex/bin/codex",
      commandSource: "config",
    });
    expect(start.managedCommandOrder).toBeUndefined();
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
      liveTestTimeoutMs: 60_000,
      toolCallTimeoutMs: 60_000,
      healthCheckEnabled: false,
      healthCheckIntervalMinutes: 60,
      pluginCacheMode: "independent",
      strictReadiness: false,
      autoRepair: false,
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
        liveTestTimeoutMs: 60_000,
        toolCallTimeoutMs: 60_000,
        healthCheckEnabled: false,
        healthCheckIntervalMinutes: 60,
        pluginCacheMode: "independent",
        strictReadiness: false,
        autoRepair: false,
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
          liveTestTimeoutMs: 60_000,
          toolCallTimeoutMs: 60_000,
          healthCheckEnabled: false,
          healthCheckIntervalMinutes: 60,
          pluginCacheMode: "independent",
          strictReadiness: false,
          autoRepair: false,
        },
      );
    }
  });

  it("resolves Computer Use operational policy knobs", () => {
    expectFields(
      resolveCodexComputerUseConfig({
        pluginConfig: {
          computerUse: {
            enabled: true,
            liveTestTimeoutMs: 45_000,
            toolCallTimeoutMs: 55_000,
            healthCheckEnabled: true,
            healthCheckIntervalMinutes: 120,
            pluginCacheMode: "independent",
            strictReadiness: true,
            autoRepair: true,
          },
        },
        env: {
          OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_ENABLED: "false",
          OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_INTERVAL_MINUTES: "240",
          OPENCLAW_CODEX_COMPUTER_USE_STRICT_READINESS: "false",
          OPENCLAW_CODEX_COMPUTER_USE_AUTO_REPAIR: "false",
        },
      }),
      "computer use config",
      {
        enabled: true,
        liveTestTimeoutMs: 45_000,
        toolCallTimeoutMs: 55_000,
        healthCheckEnabled: true,
        healthCheckIntervalMinutes: 120,
        pluginCacheMode: "independent",
        strictReadiness: true,
        autoRepair: true,
      },
    );

    expectFields(
      resolveCodexComputerUseConfig({
        pluginConfig: { computerUse: { enabled: true } },
        env: {
          OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_ENABLED: "1",
          OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_INTERVAL_MINUTES: "90",
          OPENCLAW_CODEX_COMPUTER_USE_STRICT_READINESS: "true",
          OPENCLAW_CODEX_COMPUTER_USE_AUTO_REPAIR: "true",
          OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_CACHE_MODE: "stale-copy",
        },
      }),
      "computer use config",
      {
        healthCheckEnabled: true,
        healthCheckIntervalMinutes: 60,
        pluginCacheMode: "independent",
        strictReadiness: true,
        autoRepair: true,
      },
    );
  });

  it("allows plugin config to opt in to guardian-reviewed local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
      modelProvider: "openai",
      env: {},
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  it("uses user approvals for explicit guardian mode when model provider is unknown", () => {
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
      approvalsReviewer: "user",
    });
  });

  it("allows environment mode fallback to opt in to guardian-reviewed local execution", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      modelProvider: "openai",
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
      modelProvider: "openai",
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
      modelProvider: "openai",
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
      modelProvider: "openai",
      env: {},
    });
    const envRuntime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
      modelProvider: "openai",
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

  it("fails closed when Guardian local-model fallback needs user approvals but requirements disallow them", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: { appServer: { mode: "guardian" } },
        modelProvider: "lmstudio",
        model: "local-model",
        requirementsToml: 'allowed_approvals_reviewers = ["auto_review"]\n',
      }),
    ).toThrow("tools.exec.mode=ask requires Codex app-server user approvals");
  });

  it.each([
    { execMode: "auto", policies: ["never"] },
    { execMode: "auto", policies: ["untrusted"] },
    { execMode: "ask", policies: ["never"] },
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

  it("keeps auto mode prompting when requirements use the on-failure alias", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
      requirementsToml:
        'allowed_sandbox_modes = ["read-only"]\nallowed_approval_policies = ["on-failure"]\nallowed_approvals_reviewers = ["user"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
  });

  it("prefers the normalized on-request alias over a permitted never policy", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
      requirementsToml:
        'allowed_sandbox_modes = ["danger-full-access", "read-only"]\nallowed_approval_policies = ["never", "on-failure"]\nallowed_approvals_reviewers = ["user"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
  });

  it("uses user approvals when normalized OpenClaw auto mode cannot use Codex auto-review", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {},
      execMode: "auto",
      requirementsToml:
        'allowed_approval_policies = ["on-request"]\nallowed_approvals_reviewers = ["user"]\n',
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
  });

  it.each([
    { modelProvider: undefined, model: undefined },
    { modelProvider: "lmstudio", model: "local-model" },
    { modelProvider: "codex", model: "gpt-5.5" },
    { modelProvider: "codex", model: "lmstudio/local-model" },
  ])(
    "uses user approvals for local-model auto exec before requirements validation",
    ({ modelProvider, model }) => {
      const runtime = resolveRuntimeForTest({
        pluginConfig: {},
        execMode: "auto",
        modelProvider,
        model,
        requirementsToml:
          'allowed_approval_policies = ["on-request"]\nallowed_approvals_reviewers = ["user"]\n',
      });

      expectRuntimePolicy(runtime, {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      });
    },
  );

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
      modelProvider: "openai",
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
        homeScope: "agent",
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
      modelProvider: "openai",
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
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

  it("accepts the latest auto_review reviewer and legacy guardian_subagent alias", () => {
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { approvalsReviewer: "auto_review" } },
        modelProvider: "openai",
        env: {},
      }).approvalsReviewer,
    ).toBe("auto_review");
    expect(
      resolveRuntimeForTest({
        pluginConfig: { appServer: { approvalsReviewer: "guardian_subagent" } },
        modelProvider: "openai",
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

  it("normalizes the deprecated approval-policy config alias without dropping other settings", () => {
    const pluginConfig = readCodexPluginConfig({
      appServer: {
        mode: "guardian",
        approvalPolicy: "on-failure",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        command: "/opt/codex/bin/codex",
      },
    });
    expect(pluginConfig.appServer).toMatchObject({
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
      command: "/opt/codex/bin/codex",
    });

    const runtime = resolveRuntimeForTest({
      pluginConfig,
      env: {},
    });

    expectRuntimePolicy(runtime, {
      approvalPolicy: "on-request",
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

  it("derives distinct shared-client keys for distinct auth binding fingerprints", () => {
    const options = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: {},
    };
    const first = codexAppServerStartOptionsKey(options, {
      authProfileId: "openai:work",
      authBindingFingerprint: "auth-fingerprint-a",
    });
    const second = codexAppServerStartOptionsKey(options, {
      authProfileId: "openai:work",
      authBindingFingerprint: "auth-fingerprint-b",
    });

    expect(first).not.toEqual(second);
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

  it("derives distinct shared-client keys for managed binary order", () => {
    const packageFirst = codexAppServerStartOptionsKey({
      transport: "stdio",
      command: "codex",
      commandSource: "managed",
      args: ["app-server"],
      headers: {},
    });
    const desktopFirst = codexAppServerStartOptionsKey({
      transport: "stdio",
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
      args: ["app-server"],
      headers: {},
    });

    expect(packageFirst).not.toEqual(desktopFirst);
  });

  it("derives distinct shared-client keys for native Computer Use identities", () => {
    const keyFor = (pluginName: string) =>
      codexAppServerStartOptionsKey({
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        managedComputerUsePluginNames: ["computer-use", pluginName],
        args: ["app-server"],
        headers: {},
      });

    expect(keyFor("custom-a")).not.toEqual(keyFor("custom-b"));
  });

  it("derives distinct shared-client keys for distinct headers without exposing them", () => {
    const first = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      headers: {
        Authorization: "Bearer first",
        "x-codex-client-session-token": "session-first",
      },
    });
    const second = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      headers: {
        Authorization: "Bearer second",
        "x-codex-client-session-token": "session-second",
      },
    });

    expect(first).not.toEqual(second);
    expect(
      codexAppServerStartOptionsKey({
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        headers: {
          Authorization: "Bearer first",
          "x-codex-client-session-token": "session-first",
        },
      }),
    ).toEqual(first);
    expect(first).not.toContain("Bearer first");
    expect(first).not.toContain("session-first");
    expect(second).not.toContain("Bearer second");
    expect(second).not.toContain("session-second");
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

  it("derives distinct shared-client keys for distinct process working directories", () => {
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: {},
    };

    expect(codexAppServerStartOptionsKey({ ...startOptions, cwd: "/tmp/project-a" })).not.toEqual(
      codexAppServerStartOptionsKey({ ...startOptions, cwd: "/tmp/project-b" }),
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
