// Model auth-list tests cover provider auth listing and output formatting.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../../runtime.js";
import { modelsAuthListCommand } from "./auth-list.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  externalCliDiscoveryForProviderAuth: vi.fn(() => ({ kind: "none" })),
  loadModelsConfig: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
  resolveModelsTargetAgent: vi.fn((_cfg: OpenClawConfig, rawAgentId?: string) => {
    const agentId = rawAgentId ?? "main";
    return { agentDir: `/tmp/openclaw/agents/${agentId}`, agentId };
  }),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/openclaw/agents/${agentId}`,
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  externalCliDiscoveryForProviderAuth: mocks.externalCliDiscoveryForProviderAuth,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
  resolveAuthStatePathForDisplay: (agentDir: string) => `${agentDir}/openclaw-agent.sqlite`,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", () => ({
  resolveModelsTargetAgent: mocks.resolveModelsTargetAgent,
}));

function createRuntime(): OutputRuntimeEnv & { logs: string[]; jsonPayloads: unknown[] } {
  const logs: string[] = [];
  const jsonPayloads: unknown[] = [];
  return {
    logs,
    jsonPayloads,
    log: (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    },
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeStdout: vi.fn(),
    writeJson: (value: unknown) => {
      jsonPayloads.push(value);
    },
  };
}

describe("modelsAuthListCommand", () => {
  beforeEach(() => {
    mocks.loadModelsConfig.mockReset().mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReset();
    mocks.externalCliDiscoveryForProviderAuth.mockClear();
    mocks.resolveAuthProfileDisplayLabel.mockClear();
    mocks.resolveModelsTargetAgent.mockClear();
  });

  it("filters profiles by provider and redacts credential material in JSON output", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:user@example.com": {
          type: "oauth",
          provider: "openai",
          access: "access-secret",
          refresh: "refresh-secret",
          expires: 1_800_000_000_000,
          email: "user@example.com",
        },
        "anthropic:manual": {
          type: "token",
          provider: "anthropic",
          token: "token-secret",
        },
      },
      usageStats: {
        "openai:user@example.com": {
          cooldownUntil: 1_800_000_010_000,
        },
      },
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const runtime = createRuntime();

    await modelsAuthListCommand({ provider: "OpenAI", agent: "coder", json: true }, runtime);

    expect(mocks.resolveModelsTargetAgent).toHaveBeenCalledWith(expect.anything(), "coder", {
      kind: "read",
    });
    expect(mocks.externalCliDiscoveryForProviderAuth).toHaveBeenCalledWith({
      cfg: {},
      provider: "openai",
    });
    expect(runtime.jsonPayloads).toStrictEqual([
      {
        agentDir: "/tmp/openclaw/agents/coder",
        agentId: "coder",
        authStatePath: "/tmp/openclaw/agents/coder/openclaw-agent.sqlite",
        profiles: [
          {
            cooldownUntil: "2027-01-15T08:00:10.000Z",
            email: "user@example.com",
            expiresAt: "2027-01-15T08:00:00.000Z",
            id: "openai:user@example.com",
            label: "openai:user@example.com",
            provider: "openai",
            recoveryHint: "Wait for cooldown or switch provider.",
            type: "oauth",
          },
        ],
        provider: "openai",
      },
    ]);
    expect(JSON.stringify(runtime.jsonPayloads[0])).not.toContain("secret");
  });

  it("shows the cooldown reason and re-authentication action in text and JSON", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "secret",
          refresh: "secret",
          expires: 1_900_000_000_000,
        },
      },
      usageStats: {
        "anthropic:claude-cli": {
          cooldownUntil: 1_900_000_100_000,
          cooldownReason: "session_expired",
        },
      },
    } satisfies AuthProfileStore);

    const textRuntime = createRuntime();
    await modelsAuthListCommand({}, textRuntime);
    expect(textRuntime.logs.at(-1)).toContain("cooldown:session_expired");
    expect(textRuntime.logs.at(-1)).toContain(
      "claude auth login && openclaw models auth login --provider anthropic --method cli",
    );

    const jsonRuntime = createRuntime();
    await modelsAuthListCommand({ json: true }, jsonRuntime);
    expect(jsonRuntime.jsonPayloads[0]).toMatchObject({
      profiles: [
        expect.objectContaining({
          id: "anthropic:claude-cli",
          cooldownReason: "session_expired",
          recoveryHint:
            "Re-authenticate with `claude auth login && openclaw models auth login --provider anthropic --method cli --profile-id 'anthropic:claude-cli'`.",
        }),
      ],
    });
  });

  it("shows exact WHAM classification without hiding the canonical reason in JSON", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:expired": {
          type: "oauth",
          provider: "openai",
          access: "secret",
          refresh: "secret",
          expires: 1_900_000_000_000,
        },
      },
      usageStats: {
        "openai:expired": {
          cooldownUntil: 1_900_000_100_000,
          cooldownReason: "auth",
          cooldownClassification: "wham_token_expired",
        },
      },
    } satisfies AuthProfileStore);

    const textRuntime = createRuntime();
    await modelsAuthListCommand({}, textRuntime);
    expect(textRuntime.logs.at(-1)).toContain("cooldown:wham_token_expired");

    const jsonRuntime = createRuntime();
    await modelsAuthListCommand({ json: true }, jsonRuntime);
    expect(jsonRuntime.jsonPayloads[0]).toMatchObject({
      profiles: [
        expect.objectContaining({
          cooldownReason: "auth",
          cooldownClassification: "wham_token_expired",
        }),
      ],
    });
  });

  it("routes legacy Gemini CLI cooldowns to supported Google API-key setup", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "google-gemini-cli:legacy": {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "secret",
          refresh: "secret",
          expires: 1_900_000_000_000,
        },
      },
      usageStats: {
        "google-gemini-cli:legacy": {
          cooldownUntil: 1_900_000_100_000,
          cooldownReason: "session_expired",
        },
      },
    } satisfies AuthProfileStore);

    const runtime = createRuntime();
    await modelsAuthListCommand({ json: true }, runtime);

    expect(runtime.jsonPayloads[0]).toMatchObject({
      profiles: [
        expect.objectContaining({
          id: "google-gemini-cli:legacy",
          recoveryHint: expect.stringContaining("--provider google`"),
        }),
      ],
    });
    expect(JSON.stringify(runtime.jsonPayloads[0])).not.toContain("--provider google-gemini-cli");
  });

  it("treats the OpenAI filter as the friendly view over API-key and OAuth profiles", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:user@example.com": {
          type: "oauth",
          provider: "openai",
          access: "access-secret",
          refresh: "refresh-secret",
          expires: 1_800_000_000_000,
          email: "user@example.com",
        },
        "openai:api-key-backup": {
          type: "api_key",
          provider: "openai",
          key: "sk-secret",
        },
        "anthropic:manual": {
          type: "token",
          provider: "anthropic",
          token: "token-secret",
        },
      },
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const runtime = createRuntime();

    await modelsAuthListCommand({ provider: "OpenAI", json: true }, runtime);

    expect(mocks.externalCliDiscoveryForProviderAuth).toHaveBeenCalledWith({
      cfg: {},
      provider: "openai",
    });
    expect(runtime.jsonPayloads).toStrictEqual([
      {
        agentDir: "/tmp/openclaw/agents/main",
        agentId: "main",
        authStatePath: "/tmp/openclaw/agents/main/openclaw-agent.sqlite",
        profiles: [
          {
            id: "openai:api-key-backup",
            label: "openai:api-key-backup",
            provider: "openai",
            type: "api_key",
          },
          {
            email: "user@example.com",
            expiresAt: "2027-01-15T08:00:00.000Z",
            id: "openai:user@example.com",
            label: "openai:user@example.com",
            provider: "openai",
            type: "oauth",
          },
        ],
        provider: "openai",
      },
    ]);
    expect(JSON.stringify(runtime.jsonPayloads[0])).not.toContain("secret");
  });

  it("prints an empty profile list without failing", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    const runtime = createRuntime();

    await modelsAuthListCommand({}, runtime);

    expect(runtime.logs).toEqual([
      "Agent: main",
      "Auth state store: /tmp/openclaw/agents/main/openclaw-agent.sqlite",
      "Profiles: (none)",
    ]);
  });

  it("omits Date-invalid auth timestamps without failing", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:user@example.com": {
          type: "oauth",
          provider: "openai",
          access: "access-secret",
          refresh: "refresh-secret",
          expires: 8_700_000_000_000_000,
          email: "user@example.com",
        },
      },
      usageStats: {
        "openai:user@example.com": {
          cooldownUntil: 8_700_000_000_000_000,
        },
      },
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const runtime = createRuntime();

    await modelsAuthListCommand({ provider: "openai", json: true }, runtime);

    expect(runtime.jsonPayloads).toStrictEqual([
      {
        agentDir: "/tmp/openclaw/agents/main",
        agentId: "main",
        authStatePath: "/tmp/openclaw/agents/main/openclaw-agent.sqlite",
        profiles: [
          {
            email: "user@example.com",
            id: "openai:user@example.com",
            label: "openai:user@example.com",
            provider: "openai",
            type: "oauth",
          },
        ],
        provider: "openai",
      },
    ]);
  });
});
