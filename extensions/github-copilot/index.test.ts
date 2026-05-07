import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  githubCopilotLoginCommand: vi.fn(),
  resolveCopilotApiToken: vi.fn(),
}));

vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotApiToken: mocks.resolveCopilotApiToken,
  githubCopilotLoginCommand: mocks.githubCopilotLoginCommand,
  fetchCopilotUsage: vi.fn(),
}));

import plugin from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  vi.doUnmock("./register.runtime.js");
  vi.resetModules();
});

async function createAgentDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-copilot-test-"));
  tempDirs.push(dir);
  return dir;
}

function _registerProvider() {
  return registerProviderWithPluginConfig({});
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      id: "github-copilot",
      name: "GitHub Copilot",
      source: "test",
      config: {},
      pluginConfig,
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("github-copilot plugin", () => {
  it("registers embedding provider", () => {
    const registerMemoryEmbeddingProviderMock = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "github-copilot",
        name: "GitHub Copilot",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerProvider: vi.fn(),
        registerMemoryEmbeddingProvider: registerMemoryEmbeddingProviderMock,
      }),
    );

    expect(registerMemoryEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    const adapter = registerMemoryEmbeddingProviderMock.mock.calls[0]?.[0];
    expect(adapter.id).toBe("github-copilot");
  });

  it("skips catalog discovery when plugin discovery is disabled", async () => {
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            "github-copilot": {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
    } as never);

    expect(result).toBeNull();
    expect(mocks.resolveCopilotApiToken).not.toHaveBeenCalled();
  });

  it("uses live plugin config to re-enable discovery after startup disable", async () => {
    mocks.resolveCopilotApiToken.mockResolvedValueOnce({
      token: "copilot_api_token",
      baseUrl: "https://api.githubcopilot.live",
    });
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            "github-copilot": {
              config: {
                discovery: { enabled: true },
              },
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
    } as never);

    expect(mocks.resolveCopilotApiToken).toHaveBeenCalledWith({
      githubToken: "gh_test_token",
      env: { GH_TOKEN: "gh_test_token" },
    });
    expect(result).toEqual({
      provider: {
        baseUrl: "https://api.githubcopilot.live",
        models: [],
      },
    });
  });

  it("offers to reuse an existing token profile during interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = provider.auth[0];
    const agentDir = await createAgentDir();
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "github-copilot:github": {
            type: "token",
            provider: "github-copilot",
            token: "existing-token",
          },
        },
      }),
    );
    const prompter = {
      confirm: vi.fn(async () => false),
      note: vi.fn(),
    };

    const result = await method.run({
      config: {},
      env: {},
      agentDir,
      workspaceDir: "/tmp/workspace",
      prompter,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      opts: {},
      secretInputMode: "plaintext",
      allowSecretRefPrompt: false,
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as never);

    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "GitHub Copilot auth already exists. Re-run login?",
      initialValue: false,
    });
    expect(mocks.githubCopilotLoginCommand).not.toHaveBeenCalled();
    expect(result).toEqual({
      profiles: [
        {
          profileId: "github-copilot:github",
          credential: {
            type: "token",
            provider: "github-copilot",
            token: "existing-token",
          },
        },
      ],
      defaultModel: "github-copilot/claude-opus-4.7",
    });
  });

  it("can refresh an existing token profile during interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = provider.auth[0];
    const agentDir = await createAgentDir();
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "github-copilot:github": {
            type: "token",
            provider: "github-copilot",
            token: "existing-token",
          },
        },
      }),
    );
    const fetchMock = vi.fn(async (input: unknown) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : String(input);
      if (target === "https://github.com/login/device/code") {
        return new Response(
          JSON.stringify({
            device_code: "device-code-stub",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (target === "https://github.com/login/oauth/access_token") {
        return new Response(
          JSON.stringify({ access_token: "refreshed-token", token_type: "bearer" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch in github-copilot refresh test: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const prompter = {
      confirm: vi.fn(async () => true),
      note: vi.fn(),
    };
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      const result = await method.run({
        config: {},
        env: {},
        agentDir,
        workspaceDir: "/tmp/workspace",
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        opts: {},
        secretInputMode: "plaintext",
        allowSecretRefPrompt: false,
        isRemote: false,
        openUrl: vi.fn(),
        oauth: { createVpsAwareHandlers: vi.fn() },
      } as never);

      expect(prompter.confirm).toHaveBeenCalledWith({
        message: "GitHub Copilot auth already exists. Re-run login?",
        initialValue: false,
      });
      expect(mocks.githubCopilotLoginCommand).not.toHaveBeenCalled();
      expect(result.profiles[0]?.credential).toEqual({
        type: "token",
        provider: "github-copilot",
        token: "refreshed-token",
      });
    } finally {
      vi.unstubAllGlobals();
      if (isTtyDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it("stores GitHub Copilot token from non-interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = provider.auth[0];
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: { githubCopilotToken: "ghu_test\r\n123" },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_test123",
        source: "flag" as const,
      })),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });
    expect(result?.agents?.defaults?.model).toEqual({
      primary: "github-copilot/claude-opus-4.7",
    });
    expect(result?.agents?.defaults?.models?.["github-copilot/claude-opus-4.7"]).toEqual({});

    const profile = ensureAuthProfileStore(agentDir).profiles["github-copilot:github"];
    expect(profile).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "ghu_test123",
    });
  });

  it("stores env-backed token refs for non-interactive onboarding ref mode", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = provider.auth[0];
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: { agents: { defaults: { model: { fallbacks: ["openai/gpt-5.4"] } } } },
      baseConfig: {},
      opts: { secretInputMode: "ref" },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_from_env",
        source: "env" as const,
        envVarName: "COPILOT_GITHUB_TOKEN",
      })),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.agents?.defaults?.model).toEqual({
      fallbacks: ["openai/gpt-5.4"],
      primary: "github-copilot/claude-opus-4.7",
    });

    const profile = ensureAuthProfileStore(agentDir).profiles["github-copilot:github"];
    expect(profile).toEqual({
      type: "token",
      provider: "github-copilot",
      tokenRef: {
        source: "env",
        provider: "default",
        id: "COPILOT_GITHUB_TOKEN",
      },
    });
  });

  it("falls back to GH_TOKEN during non-interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = provider.auth[0];
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };
    const resolveApiKey = vi.fn(async ({ envVar }: { envVar?: string }) =>
      envVar === "GH_TOKEN"
        ? {
            key: "ghu_from_gh_token",
            source: "env" as const,
            envVarName: "GH_TOKEN",
          }
        : null,
    );

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: {},
      runtime,
      agentDir,
      resolveApiKey,
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ envVar: "COPILOT_GITHUB_TOKEN" }),
    );
    expect(resolveApiKey).toHaveBeenCalledWith(expect.objectContaining({ envVar: "GH_TOKEN" }));
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });

    const profile = ensureAuthProfileStore(agentDir).profiles["github-copilot:github"];
    expect(profile).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "ghu_from_gh_token",
    });
  });

  it("preserves an existing primary model during non-interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = provider.auth[0];
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {
        agents: {
          defaults: {
            model: {
              primary: "github-copilot/gpt-5.4",
              fallbacks: ["openai/gpt-5.4"],
            },
            models: {
              "github-copilot/gpt-5.4": { label: "Existing" },
            },
          },
        },
      },
      baseConfig: {},
      opts: { githubCopilotToken: "ghu_test" },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_test",
        source: "flag" as const,
      })),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.agents?.defaults?.model).toEqual({
      primary: "github-copilot/gpt-5.4",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(result?.agents?.defaults?.models).toEqual({
      "github-copilot/gpt-5.4": { label: "Existing" },
    });
  });

  it("reuses an existing token profile during non-interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = provider.auth[0];
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "github-copilot:github": {
            type: "token",
            provider: "github-copilot",
            token: "existing-token",
          },
        },
      }),
    );

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: {},
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => null),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });
  });

  it("does not emit a second missing-token error after ref-mode flag validation fails", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = provider.auth[0];
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: {
        githubCopilotToken: "ghu_secret",
        secretInputMode: "ref",
      },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => null),
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "--github-copilot-token cannot be used with --secret-input-mode ref unless COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN is set in env.",
        "Set one of those env vars and omit --github-copilot-token, or use --secret-input-mode plaintext.",
      ].join("\n"),
    );
  });
});
