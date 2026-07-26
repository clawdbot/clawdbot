// Setup inference verification tests keep noninteractive imports prompt-free.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInferenceConfig: mocks.verify,
}));
vi.mock("../agents/auth-profiles/store.js", () => ({
  updateAuthProfileStoreWithLock: vi.fn(),
}));
vi.mock("../state/openclaw-agent-db.js", () => ({
  disposeOpenClawAgentDatabaseByPath: vi.fn(),
}));
vi.mock("./setup.model-auth.js", () => ({
  runSetupModelAuthStep: mocks.repair,
}));

import { offerLiveModelVerification } from "./setup.inference-verification.js";

describe("offerLiveModelVerification", () => {
  beforeEach(() => {
    mocks.repair.mockReset();
    mocks.verify.mockReset();
  });

  it("does not enter interactive repair for a failed noninteractive import", async () => {
    mocks.verify.mockResolvedValue({ ok: false, status: "auth", error: "credential expired" });
    const select = vi.fn();
    const prompter = {
      intro: vi.fn(),
      outro: vi.fn(),
      note: vi.fn(),
      confirm: vi.fn(),
      select,
      multiselect: vi.fn(),
      text: vi.fn(),
      progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
    } as unknown as WizardPrompter;

    await expect(
      offerLiveModelVerification({
        config: { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } },
        opts: { nonInteractive: true },
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
        workspaceDir: "/tmp/openclaw-test-workspace",
        writeConfig: async (config) => config,
        required: true,
      }),
    ).resolves.toEqual({
      config: { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } },
      attempted: true,
      persisted: false,
      verified: false,
    });

    expect(select).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("reports when a repair candidate persisted its verified config", async () => {
    const repairedConfig: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
      models: {
        providers: {
          openai: { apiKey: "test-key", baseUrl: "https://api.openai.com/v1", models: [] },
        },
      },
    };
    const persistAuthProfiles = vi.fn(async () => {});
    const writeConfig = vi.fn(async () => repairedConfig);
    mocks.verify
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "credential expired" })
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.6", latencyMs: 10 });
    mocks.repair.mockResolvedValue({
      config: repairedConfig,
      authProfiles: [],
      persistAuthProfiles,
    });
    const prompter = {
      intro: vi.fn(),
      outro: vi.fn(),
      note: vi.fn(),
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "fix"),
      multiselect: vi.fn(),
      text: vi.fn(),
      progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
    } as unknown as WizardPrompter;

    await expect(
      offerLiveModelVerification({
        config: { agents: { entries: { main: { default: true } } } },
        opts: {},
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
        workspaceDir: "/tmp/openclaw-test-workspace",
        writeConfig,
      }),
    ).resolves.toEqual({
      config: repairedConfig,
      attempted: true,
      persisted: true,
      verified: true,
      modelRef: "openai/gpt-5.6",
    });
    expect(persistAuthProfiles).toHaveBeenCalledOnce();
    expect(writeConfig).toHaveBeenCalledOnce();
  });
});
