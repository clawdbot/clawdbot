import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { SystemAgentChatEngine } from "./chat-engine.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";
import type {
  SystemAgentVerifiedInferenceBinding,
  SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

const verifiedInferenceConfig = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        auth: "api-key",
        models: [],
      },
    },
  },
} satisfies OpenClawConfig;

let verifiedInference: SystemAgentVerifiedInferenceBinding;
let verifiedInferenceDeps: SystemAgentVerifiedInferenceDeps;

function verifiedConfigSnapshot(): ConfigFileSnapshot {
  const config = structuredClone(verifiedInferenceConfig);
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    raw: null,
    parsed: config,
    config,
    runtimeConfig: config,
    sourceConfig: config,
    resolved: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

const mocks = vi.hoisted(() => {
  const hook = { channel: "matrix", accountId: "default", run: vi.fn() };
  return {
    hook,
    writeWizardConfigFile: vi.fn(async () => ({
      channels: { matrix: { enabled: true, committed: true } },
    })),
    runCollectedChannelOnboardingPostWriteHooks: vi.fn(async () => {}),
    setupChannels: vi.fn(async (_cfg, _runtime, _prompter, options) => {
      options?.onPostWriteHook?.(hook);
      return { channels: { matrix: { enabled: true } } };
    }),
  };
});

vi.mock("../wizard/setup.shared.js", () => ({
  readSetupConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    hash: "hash",
    config: {},
    sourceConfig: {},
  })),
  writeWizardConfigFile: mocks.writeWizardConfigFile,
}));

vi.mock("../commands/onboard-channels.js", () => ({
  createChannelOnboardingPostWriteHookCollector: () => {
    const hooks: unknown[] = [];
    return {
      collect: (hook: unknown) => hooks.push(hook),
      drain: () => hooks.splice(0),
    };
  },
  runCollectedChannelOnboardingPostWriteHooks: mocks.runCollectedChannelOnboardingPostWriteHooks,
  setupChannels: mocks.setupChannels,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config: {},
    sourceConfig: {},
    issues: [],
  })),
}));

beforeAll(async () => {
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedInferenceConfig);
  verifiedInference = fixture.binding;
  verifiedInferenceDeps = fixture.deps;
});

describe("OpenClaw chat channel setup", () => {
  it("runs collected channel hooks after writing config", async () => {
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: {
        ...verifiedInferenceDeps,
        readConfigFileSnapshot: async () => verifiedConfigSnapshot(),
        loadOverview: async () =>
          ({
            config: {
              path: "/tmp/openclaw.json",
              exists: true,
              valid: true,
              issues: [],
              hash: "h",
            },
            agents: [],
            defaultAgentId: "main",
            tools: {
              codex: { command: "codex", found: false },
              claude: { command: "claude", found: false },
              gemini: { command: "gemini", found: false },
              apiKeys: { openai: false, anthropic: false },
            },
            gateway: { url: "ws://127.0.0.1:18789", source: "local", reachable: false },
            references: {
              docsUrl: "https://docs.openclaw.ai",
              sourceUrl: "https://github.com/openclaw/openclaw",
            },
          }) as never,
      },
    });

    const reply = await engine.handle("connect matrix");

    expect(reply.text).toContain("matrix is configured");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      { channels: { matrix: { enabled: true } } },
      { allowConfigSizeDrop: false, baseHash: "hash", migrationBaseConfig: {} },
    );
    expect(mocks.setupChannels).toHaveBeenCalledWith(
      {},
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ beforePersistentEffect: expect.any(Function) }),
    );
    expect(mocks.runCollectedChannelOnboardingPostWriteHooks).toHaveBeenCalledWith({
      hooks: [mocks.hook],
      cfg: { channels: { matrix: { enabled: true, committed: true } } },
      runtime: expect.any(Object),
      beforePersistentEffect: expect.any(Function),
    });
  });
});
