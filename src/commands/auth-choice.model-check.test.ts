import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { warnIfModelConfigLooksOff } from "./auth-choice.model-check.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog,
}));

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ version: 1, profiles: {} })));
const listProfilesForProvider = vi.hoisted(() => vi.fn(() => []));
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
}));

const resolveEnvApiKey = vi.hoisted(() => vi.fn(() => undefined));
const hasUsableCustomProviderApiKey = vi.hoisted(() => vi.fn(() => false));
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  hasUsableCustomProviderApiKey,
}));

describe("warnIfModelConfigLooksOff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadModelCatalog.mockResolvedValue([]);
  });

  it("skips catalog validation when requested while keeping auth checks", async () => {
    const note = vi.fn(async () => {});
    const prompter = makePrompter({ note });
    const config = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    await warnIfModelConfigLooksOff(config, prompter, { validateCatalog: false });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore).toHaveBeenCalledOnce();
    expect(listProfilesForProvider).toHaveBeenCalledOnce();
    const [profileStore, providerId] = listProfilesForProvider.mock.calls[0] as unknown as [
      AuthProfileStore,
      string,
    ];
    expect(profileStore?.profiles).toEqual({});
    expect(providerId).toBe("openai-codex");
    expect(note).toHaveBeenCalledWith(
      'No auth configured for provider "openai-codex". The agent may fail until credentials are added. Run `openclaw models auth login --provider openai-codex`, `openclaw configure`, or set an API key env var.',
      "Model check",
    );
  });

  it("keeps full catalog validation enabled by default", async () => {
    const note = vi.fn(async () => {});
    const prompter = makePrompter({ note });
    const config = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    await warnIfModelConfigLooksOff(config, prompter);

    expect(loadModelCatalog).toHaveBeenCalledWith({
      config,
      useCache: false,
    });
  });
});
