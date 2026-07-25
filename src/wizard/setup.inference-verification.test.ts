// Setup inference verification tests keep noninteractive imports prompt-free.
import { describe, expect, it, vi } from "vitest";
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
      verified: false,
    });

    expect(select).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });
});
