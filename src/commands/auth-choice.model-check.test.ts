// Auth-choice model check tests cover warnings for mismatched model and auth config.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveDefaultModelAuthStatus,
  warnIfModelConfigLooksOff,
} from "./auth-choice.model-check.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
const modelCatalogMocks = vi.hoisted(() => ({
  routeVariants: undefined as unknown[] | undefined,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await loadModelCatalog(...args);
    return { entries, routeVariants: modelCatalogMocks.routeVariants ?? entries };
  },
}));

const openAIRouteMocks = vi.hoisted(() => ({
  override: undefined as ((params: unknown) => unknown) | undefined,
}));
vi.mock("../agents/openai-model-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/openai-model-routes.js")>();
  return {
    ...actual,
    resolveOpenAIModelRoutes: (params: Parameters<typeof actual.resolveOpenAIModelRoutes>[0]) =>
      openAIRouteMocks.override
        ? openAIRouteMocks.override(params)
        : actual.resolveOpenAIModelRoutes(params),
    createOpenAIModelRoutesResolver: (
      params: Parameters<typeof actual.createOpenAIModelRoutesResolver>[0],
    ) => {
      const resolveRoutes = actual.createOpenAIModelRoutesResolver(params);
      return (ref: Parameters<ReturnType<typeof actual.createOpenAIModelRoutesResolver>>[0]) =>
        openAIRouteMocks.override ? openAIRouteMocks.override(ref) : resolveRoutes(ref);
    },
  };
});

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ version: 1, profiles: {} })));
vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  ensureAuthProfileStore,
}));

describe("warnIfModelConfigLooksOff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadModelCatalog.mockResolvedValue([]);
    modelCatalogMocks.routeVariants = undefined;
    ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    openAIRouteMocks.override = undefined;
  });

  it("skips catalog validation when requested while keeping auth checks", async () => {
    const note = vi.fn(async (_message: string) => {});
    const prompter = makePrompter({ note });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    await warnIfModelConfigLooksOff(config, prompter, { validateCatalog: false });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore).toHaveBeenCalledOnce();
    expect(ensureAuthProfileStore).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        allowKeychainPrompt: false,
        externalCliProviderIds: ["openai"],
        readOnly: true,
      }),
    );
    expect(note).toHaveBeenCalledWith(
      'No auth configured for provider "openai". The agent may fail until credentials are added. Run `openclaw models auth login --provider openai`, `openclaw configure`, or set an API key env var.',
      "Model check",
    );
  });

  it("reports missing auth for generic providers without credential evidence", () => {
    const config = {
      agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
    } as OpenClawConfig;

    expect(resolveDefaultModelAuthStatus(config, { env: {} })).toMatchObject({
      provider: "anthropic",
      status: "missing",
      hasAuth: false,
    });
  });

  it("accepts Codex OAuth profiles for canonical OpenAI models using the Codex runtime", async () => {
    const note = vi.fn(async (_message: string) => {});
    const prompter = makePrompter({ note });
    const store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies AuthProfileStore;
    ensureAuthProfileStore.mockReturnValue(store);
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
          },
        },
      },
    } as OpenClawConfig;

    await warnIfModelConfigLooksOff(config, prompter, { validateCatalog: false });

    expect(note).not.toHaveBeenCalled();
  });

  it("keeps custom OpenAI-compatible provider auth separate from Codex OAuth profiles", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = makePrompter({ note });
    const store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies AuthProfileStore;
    ensureAuthProfileStore.mockReturnValue(store);
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.test/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    await warnIfModelConfigLooksOff(config, prompter, { validateCatalog: false });

    expect(note).toHaveBeenCalledWith(
      'No auth configured for provider "openai". The agent may fail until credentials are added. Run `openclaw models auth login --provider openai`, `openclaw configure`, or set an API key env var.',
      "Model check",
    );
  });

  it("keeps full catalog validation enabled by default", async () => {
    const note = vi.fn(async () => {});
    const prompter = makePrompter({ note });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    await warnIfModelConfigLooksOff(config, prompter);

    expect(loadModelCatalog).toHaveBeenCalledWith({
      config,
      useCache: false,
    });
  });

  it("accepts subscription auth but not key sources for gpt-5.3-codex-spark", async () => {
    const config = {
      agents: { defaults: { model: "openai/gpt-5.3-codex-spark" } },
    } as OpenClawConfig;
    expect(
      resolveDefaultModelAuthStatus(config, { env: { OPENAI_API_KEY: "api-key" } }),
    ).toMatchObject({
      status: "missing",
      hasAuth: false,
      authRequirement: "subscription",
    });

    const note = vi.fn(async (_message: string) => {});
    await warnIfModelConfigLooksOff(config, makePrompter({ note }), {
      validateCatalog: false,
      env: { OPENAI_API_KEY: "api-key" },
    });
    const warning = note.mock.calls.flatMap(([message]) => message).join("\n");
    expect(warning).toContain("openclaw models auth login --provider openai");
    expect(warning).not.toContain("set an API key env var");

    const store = {
      version: 1,
      profiles: {
        "openai:subscription": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies AuthProfileStore;
    ensureAuthProfileStore.mockReturnValue(store);
    expect(resolveDefaultModelAuthStatus(config)).toMatchObject({ status: "ready", hasAuth: true });
  });

  it("maps incompatible route facts to status and recovery wording", async () => {
    const store = {
      version: 1,
      profiles: {
        "openai:subscription": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies AuthProfileStore;
    ensureAuthProfileStore.mockReturnValue(store);
    const config = {
      agents: { defaults: { model: "openai/gpt-5.6" } },
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveDefaultModelAuthStatus(config)).toMatchObject({
      status: "incompatible",
      hasAuth: false,
      code: "platform-only-model-on-chatgpt",
    });
    const note = vi.fn(async () => {});
    await warnIfModelConfigLooksOff(config, makePrompter({ note }), {
      validateCatalog: false,
    });

    expect(note).toHaveBeenCalledWith(
      'Model route is incompatible for "openai/gpt-5.6": gpt-5.6 is available only through OpenAI Platform API-key authentication.',
      "Model check",
    );
  });

  it("uses selected static ChatGPT catalog facts for auth checks", async () => {
    const note = vi.fn(async () => {});
    const prompter = makePrompter({ note });
    const store = {
      version: 1,
      profiles: {
        "openai:subscription": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies AuthProfileStore;
    ensureAuthProfileStore.mockReturnValue(store);
    loadModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.4-nano",
        name: "GPT 5.4 Nano",
        provider: "openai",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    ]);
    const config = {
      agents: { defaults: { model: "openai/gpt-5.4-nano" } },
    } as OpenClawConfig;

    await warnIfModelConfigLooksOff(config, prompter);

    expect(note).not.toHaveBeenCalled();
  });

  it("matches shipped OpenAI aliases to their canonical catalog model", async () => {
    const note = vi.fn(async () => {});
    loadModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.4",
        name: "GPT 5.4",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);
    const config = {
      agents: { defaults: { model: "openai/gpt-5.4-codex" } },
    } as OpenClawConfig;

    await warnIfModelConfigLooksOff(config, makePrompter({ note }), {
      env: { OPENAI_API_KEY: "api-key" },
    });

    expect(note).not.toHaveBeenCalled();
  });

  it.each([
    ["Platform first", false],
    ["ChatGPT first", true],
  ])("uses every physical route for a logical model: %s", async (_label, chatGPTFirst) => {
    const platform = {
      id: "gpt-5.4-nano",
      name: "GPT 5.4 Nano",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const chatGPT = {
      ...platform,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    loadModelCatalog.mockResolvedValue([platform]);
    modelCatalogMocks.routeVariants = chatGPTFirst ? [chatGPT, platform] : [platform, chatGPT];
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:subscription": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    const note = vi.fn(async () => {});
    const config = {
      agents: { defaults: { model: "openai/gpt-5.4-nano" } },
    } as OpenClawConfig;

    await warnIfModelConfigLooksOff(config, makePrompter({ note }));

    expect(note).not.toHaveBeenCalled();
  });

  it("reports an unknown static transport as indeterminate instead of missing auth", async () => {
    const note = vi.fn(async () => {});
    const prompter = makePrompter({ note });
    const config = {
      agents: { defaults: { model: "openai/gpt-5.4-nano" } },
    } as OpenClawConfig;

    expect(resolveDefaultModelAuthStatus(config)).toMatchObject({
      status: "indeterminate",
      hasAuth: false,
    });
    await warnIfModelConfigLooksOff(config, prompter, { validateCatalog: false });

    expect(note).toHaveBeenCalledWith(
      'Auth readiness could not be confirmed for "openai/gpt-5.4-nano". Verify the selected model route and credential source before continuing.',
      "Model check",
    );
  });

  it("keeps OpenAI route checks indeterminate when the route artifact is unavailable", () => {
    openAIRouteMocks.override = () => null;
    const config = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } as OpenClawConfig;

    expect(resolveDefaultModelAuthStatus(config)).toMatchObject({
      status: "indeterminate",
      hasAuth: false,
    });
  });
});
