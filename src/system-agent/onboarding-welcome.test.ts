import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import { buildOnboardingWelcome } from "./onboarding-welcome.js";

const mocks = vi.hoisted(() => ({
  readLocalOnboardingState: vi.fn<
    (
      configPath: string,
      config: { wizard?: { securityAcknowledgedAt?: string } },
    ) => LocalOnboardingState | undefined
  >(() => undefined),
  sourceConfig: {
    agents: { defaults: { workspace: "/existing/workspace" } },
    wizard: undefined as
      | { securityAcknowledgedAt?: string; accessMode?: "full" | "guarded" }
      | undefined,
    gateway: undefined as
      | {
          mode?: "local" | "remote";
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

vi.mock("../state/local-onboarding-state.js", () => ({
  readLocalOnboardingStateForConfig: mocks.readLocalOnboardingState,
}));

vi.mock("../commands/onboard-helpers.js", () => ({ DEFAULT_WORKSPACE: "/default/workspace" }));

describe("buildOnboardingWelcome", () => {
  beforeEach(() => {
    mocks.sourceConfig.agents.defaults.workspace = "/existing/workspace";
    mocks.sourceConfig.wizard = undefined;
    mocks.sourceConfig.gateway = undefined;
    mocks.readLocalOnboardingState.mockReset().mockReturnValue(undefined);
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

  it("resumes pending local onboarding in the receipt's authoritative workspace", async () => {
    mocks.sourceConfig.wizard = {
      securityAcknowledgedAt: "2026-07-13T00:00:00.000Z",
      accessMode: "guarded",
    };
    mocks.sourceConfig.gateway = { auth: { mode: "token", token: "existing-token" } };
    mocks.readLocalOnboardingState.mockReturnValueOnce({
      version: 1,
      status: "pending",
      runId: "pending-onboarding",
      configPath: "/tmp/openclaw.json",
      workspace: "/recovered/workspace",
      securityAcknowledgedAt: "2026-07-13T00:00:00.000Z",
      startedAtMs: 1,
    });
    const propose = vi.fn();
    const { text: welcome, question } = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: { path: "/tmp/openclaw.json", exists: true, valid: true },
          defaultModel: "openai/gpt-5.6-luna",
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
      workspace: "/requested/workspace",
      localRecovery: true,
    });

    expect(mocks.readLocalOnboardingState).toHaveBeenCalledWith(
      "/tmp/openclaw.json",
      mocks.sourceConfig,
    );
    expect(propose).toHaveBeenCalledWith({ kind: "setup", workspace: "/recovered/workspace" });
    expect(question.id).toBe("onboarding-apply-setup");
    expect(welcome).toContain("Workspace: /recovered/workspace");
  });

  it("keeps the ready welcome after a local onboarding receipt completes", async () => {
    mocks.sourceConfig.wizard = { securityAcknowledgedAt: "2026-07-13T00:00:00.000Z" };
    mocks.readLocalOnboardingState.mockReturnValueOnce({
      version: 1,
      status: "completed",
      runId: "completed-onboarding",
      configPath: "/tmp/openclaw.json",
      workspace: "/recovered/workspace",
      securityAcknowledgedAt: "2026-07-13T00:00:00.000Z",
      startedAtMs: 1,
      completedAtMs: 2,
    });
    const propose = vi.fn();
    const { question } = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: { path: "/tmp/openclaw.json", exists: true, valid: true },
          defaultModel: "openai/gpt-5.6-luna",
          gateway: { reachable: true, url: "ws://127.0.0.1:18789" },
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
      localRecovery: true,
    });

    expect(mocks.readLocalOnboardingState).toHaveBeenCalledWith(
      "/tmp/openclaw.json",
      mocks.sourceConfig,
    );
    expect(propose).not.toHaveBeenCalled();
    expect(question.id).toBe("onboarding-next-step");
  });

  it("ignores a pending receipt from a replaced configuration", async () => {
    mocks.sourceConfig.wizard = { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" };
    mocks.readLocalOnboardingState.mockImplementation((_configPath, config) =>
      config.wizard?.securityAcknowledgedAt === "2026-08-02T00:00:00.000Z"
        ? {
            version: 1,
            status: "pending",
            runId: "stale-onboarding",
            configPath: "/tmp/openclaw.json",
            workspace: "/replaced/workspace",
            securityAcknowledgedAt: "2026-08-02T00:00:00.000Z",
            startedAtMs: 1,
          }
        : undefined,
    );
    const propose = vi.fn();

    const { question } = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: { path: "/tmp/openclaw.json", exists: true, valid: true },
          defaultModel: "openai/gpt-5.6-luna",
          gateway: { reachable: true, url: "ws://127.0.0.1:18789" },
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
      localRecovery: true,
    });

    expect(mocks.readLocalOnboardingState).toHaveBeenCalledWith(
      "/tmp/openclaw.json",
      mocks.sourceConfig,
    );
    expect(propose).not.toHaveBeenCalled();
    expect(question.id).toBe("onboarding-next-step");
  });

  it("never applies machine-local recovery to Gateway onboarding", async () => {
    mocks.sourceConfig.wizard = { securityAcknowledgedAt: "2026-07-13T00:00:00.000Z" };
    mocks.readLocalOnboardingState.mockReturnValueOnce({
      version: 1,
      status: "pending",
      runId: "pending-onboarding",
      configPath: "/tmp/openclaw.json",
      workspace: "/recovered/workspace",
      securityAcknowledgedAt: "2026-07-13T00:00:00.000Z",
      startedAtMs: 1,
    });
    const propose = vi.fn();
    const { question } = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: { path: "/tmp/openclaw.json", exists: true, valid: true },
          defaultModel: "openai/gpt-5.6-luna",
          gateway: { reachable: true, url: "ws://127.0.0.1:18789" },
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
    });

    expect(mocks.readLocalOnboardingState).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
    expect(question.id).toBe("onboarding-next-step");
  });

  it("never reads a local onboarding receipt for a remote Gateway", async () => {
    mocks.sourceConfig.wizard = { securityAcknowledgedAt: "2026-07-13T00:00:00.000Z" };
    mocks.sourceConfig.gateway = { mode: "remote" };
    const propose = vi.fn();
    const { question } = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: { path: "/tmp/openclaw.json", exists: true, valid: true },
          defaultModel: "openai/gpt-5.6-luna",
          gateway: { reachable: true, url: "wss://gateway.example.test" },
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
      localRecovery: true,
    });

    expect(mocks.readLocalOnboardingState).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
    expect(question.id).toBe("onboarding-next-step");
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
      localRecovery: true,
    });

    expect(mocks.readLocalOnboardingState).not.toHaveBeenCalled();
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
    expect(question.skipAction).toBe(configured ? "exit" : undefined);
    expect(welcome.includes("Say **yes**")).toBe(!configured);
  });
});
