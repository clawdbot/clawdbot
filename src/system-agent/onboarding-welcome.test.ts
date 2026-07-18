import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOnboardingWelcome } from "./onboarding-welcome.js";

const mocks = vi.hoisted(() => ({
  sourceConfig: {
    agents: { defaults: { workspace: "/existing/workspace" } },
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

vi.mock("../commands/onboard-helpers.js", () => ({ DEFAULT_WORKSPACE: "/default/workspace" }));

describe("buildOnboardingWelcome", () => {
  beforeEach(() => {
    mocks.sourceConfig.agents.defaults.workspace = "/existing/workspace";
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
        defaultModel: "openai/gpt-5.5",
      })),
      propose,
      noteAssistantMessage,
    };

    const { text: welcome, question } = await buildOnboardingWelcome({ engine: engine as never });

    expect(propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/existing/workspace",
    });
    expect(question.id).toBe("onboarding-apply-setup");
    expect(question.options[0]).toMatchObject({
      label: "Yes — set it up",
      reply: "yes",
      recommended: true,
    });
    expect(welcome).toContain("Workspace: /existing/workspace");
    expect(welcome).toContain("AI: openai/gpt-5.5 — already verified with a real reply");
  });

  it("advertises only the route that passed the inference gate", async () => {
    const { text: welcome } = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: {
            path: "/tmp/openclaw.json",
            exists: false,
            valid: false,
            issues: [],
            hash: null,
          },
          defaultModel: "openai/gpt-5.5",
        })),
        propose: vi.fn(),
        noteAssistantMessage: vi.fn(),
      } as never,
    });

    expect(welcome).toContain("AI: openai/gpt-5.5 — already verified with a real reply");
    expect(welcome).not.toContain("Claude Code");
    expect(welcome).not.toContain("Codex login");
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
        defaultModel: "openai/gpt-5.5",
      })),
      propose,
      noteAssistantMessage: vi.fn(),
    };

    await buildOnboardingWelcome({ engine: engine as never });

    expect(propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/default/workspace",
    });
  });

  it("honors an explicit workspace override on an authored setup", async () => {
    mocks.sourceConfig.gateway = { auth: { mode: "token", token: "existing-token" } };
    const propose = vi.fn();
    const { text: welcome } = await buildOnboardingWelcome({
      workspace: "/requested/workspace",
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
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
    });

    expect(propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/requested/workspace",
    });
    expect(welcome).toContain("Workspace: /requested/workspace");
  });

  it("fails closed before proposing setup when inference is missing", async () => {
    const propose = vi.fn();
    const noteAssistantMessage = vi.fn();

    await expect(
      buildOnboardingWelcome({
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
          noteAssistantMessage,
        } as never,
      }),
    ).rejects.toThrow("requires working inference first");

    expect(propose).not.toHaveBeenCalled();
    expect(noteAssistantMessage).not.toHaveBeenCalled();
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
    const { text: welcome, question } = await buildOnboardingWelcome({
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
    expect(question.id).toBe(configured ? "onboarding-next-step" : "onboarding-apply-setup");
    expect(welcome.includes("Say **yes**")).toBe(!configured);
  });
});
