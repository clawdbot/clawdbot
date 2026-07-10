import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOnboardingWelcome } from "./onboarding-welcome.js";

const mocks = vi.hoisted(() => ({
  detectInferenceBackends: vi.fn(async () => [] as Array<Record<string, unknown>>),
  sourceConfig: {
    agents: {
      defaults: {
        workspace: "/existing/workspace",
        model: undefined as string | undefined,
      },
    },
    gateway: undefined as
      | {
          auth?: {
            mode?: string;
            token?: string | { source: "env"; provider: string; id: string };
          };
        }
      | undefined,
  },
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config: {},
    sourceConfig: mocks.sourceConfig,
    issues: [],
  })),
}));

vi.mock("../commands/onboard-inference.js", () => ({
  detectInferenceBackends: mocks.detectInferenceBackends,
}));

vi.mock("../commands/onboard-helpers.js", () => ({ DEFAULT_WORKSPACE: "/default/workspace" }));

describe("buildOnboardingWelcome", () => {
  beforeEach(() => {
    mocks.detectInferenceBackends.mockReset();
    mocks.detectInferenceBackends.mockResolvedValue([]);
    mocks.sourceConfig.agents.defaults.workspace = "/existing/workspace";
    mocks.sourceConfig.agents.defaults.model = undefined;
    mocks.sourceConfig.gateway = undefined;
  });

  it("preserves an authored workspace in a partial setup", async () => {
    mocks.sourceConfig.agents.defaults.workspace = "/existing/workspace";
    const propose = vi.fn();
    const noteAssistantMessage = vi.fn();
    const engine = {
      loadOverview: vi.fn(async () => ({
        config: {
          path: "/tmp/openclaw.json",
          exists: true,
          valid: true,
          issues: [],
          hash: "hash",
        },
        defaultModel: undefined,
      })),
      propose,
      noteAssistantMessage,
    };

    const welcome = await buildOnboardingWelcome({ engine: engine as never });

    expect(propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/existing/workspace",
      inferenceRoutes: [],
    });
    expect(welcome).toContain("Workspace: /existing/workspace");
    expect(welcome).toContain("configure a model provider with masked credential prompts");
  });

  it("ignores a blank authored workspace", async () => {
    mocks.sourceConfig.agents.defaults.workspace = "   ";
    const propose = vi.fn();
    const engine = {
      loadOverview: vi.fn(async () => ({
        config: {
          path: "/tmp/openclaw.json",
          exists: true,
          valid: true,
          issues: [],
          hash: "hash",
        },
        defaultModel: undefined,
      })),
      propose,
      noteAssistantMessage: vi.fn(),
    };

    await buildOnboardingWelcome({ engine: engine as never });

    expect(propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/default/workspace",
      inferenceRoutes: [],
    });
  });

  it("captures the exact detected route in the approval proposal", async () => {
    mocks.detectInferenceBackends.mockResolvedValue([
      {
        kind: "codex-cli",
        modelRef: "openai/gpt-5.6-sol",
        label: "Codex",
        detail: "logged in",
        credentials: true,
      },
      {
        kind: "claude-cli",
        modelRef: "claude-cli/claude-opus-4-8",
        label: "Claude Code",
        detail: "logged in",
        credentials: true,
      },
    ]);
    const propose = vi.fn();
    const welcome = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: {
            path: "/tmp/openclaw.json",
            exists: true,
            valid: true,
            issues: [],
            hash: "hash",
          },
          defaultModel: undefined,
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
    });

    expect(propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/existing/workspace",
      model: "openai/gpt-5.6-sol",
      inferenceRoutes: [
        { kind: "codex-cli", model: "openai/gpt-5.6-sol" },
        { kind: "claude-cli", model: "claude-cli/claude-opus-4-8" },
      ],
    });
    expect(welcome).toContain("Codex — openai/gpt-5.6-sol");
  });

  it("keeps an authored default model while completing partial setup", async () => {
    mocks.sourceConfig.agents.defaults.model = "openai/gpt-5.4";
    mocks.detectInferenceBackends.mockResolvedValue([
      {
        kind: "existing-model",
        modelRef: "openai/gpt-5.4",
        label: "Current model",
        detail: "already configured",
        credentials: true,
      },
      {
        kind: "codex-cli",
        modelRef: "openai/gpt-5.6-sol",
        label: "Codex",
        detail: "logged in",
        credentials: true,
      },
    ]);
    const propose = vi.fn();
    const welcome = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: {
            path: "/tmp/openclaw.json",
            exists: true,
            valid: true,
            issues: [],
            hash: "hash",
          },
          defaultModel: "openai/gpt-5.4",
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
    });

    expect(mocks.detectInferenceBackends).toHaveBeenCalledWith({ config: mocks.sourceConfig });
    expect(propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/existing/workspace",
      model: "openai/gpt-5.4",
      inferenceRoutes: [
        { kind: "existing-model", model: "openai/gpt-5.4" },
        { kind: "codex-cli", model: "openai/gpt-5.6-sol" },
      ],
    });
    expect(welcome).toContain("current model openai/gpt-5.4. I'll test it first");
  });

  it.each([
    { label: "blank token", auth: { token: "   " }, configured: false },
    {
      label: "SecretRef token",
      auth: { token: { source: "env" as const, provider: "default", id: "GATEWAY_TOKEN" } },
      configured: true,
    },
  ])("treats $label consistently with the app gate", async ({ auth, configured }) => {
    mocks.sourceConfig.gateway = { auth };
    const propose = vi.fn();
    const welcome = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: {
            path: "/tmp/openclaw.json",
            exists: true,
            valid: true,
            issues: [],
            hash: "hash",
          },
          defaultModel: "openai/gpt-5.5",
          gateway: { reachable: true, url: "ws://127.0.0.1:18789" },
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
    });

    expect(propose).toHaveBeenCalledTimes(configured ? 0 : 1);
    expect(welcome.includes("Say **yes**")).toBe(!configured);
  });
});
