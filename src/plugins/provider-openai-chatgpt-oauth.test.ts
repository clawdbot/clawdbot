/** Covers ChatGPT OAuth provider wiring exposed through plugin provider discovery. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync: vi.fn(),
  resolveProviderRuntimePlugin: vi.fn(),
  runOAuth: vi.fn(),
  runFacadeOAuth: vi.fn(),
}));

vi.mock("./provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: providerRuntimeMocks.resolveProviderRuntimePlugin,
}));

vi.mock("../plugin-sdk/facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync:
    providerRuntimeMocks.loadActivatedBundledPluginPublicSurfaceModuleSync,
}));

import { loginOpenAICodexOAuth } from "./provider-openai-chatgpt-oauth.js";

function createPrompter(): WizardPrompter {
  const spin = { update: vi.fn(), stop: vi.fn() };
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(async () => "http://localhost:1455/auth/callback?code=test"),
    confirm: vi.fn(),
    progress: vi.fn(() => spin),
  } as unknown as WizardPrompter;
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

function createCredential() {
  return {
    type: "oauth" as const,
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    email: "user@example.com",
  };
}

describe("loginOpenAICodexOAuth", () => {
  beforeEach(() => {
    for (const mock of Object.values(providerRuntimeMocks)) {
      mock.mockReset();
    }
    providerRuntimeMocks.resolveProviderRuntimePlugin.mockReturnValue({
      auth: [
        {
          id: "oauth",
          run: providerRuntimeMocks.runOAuth,
        },
      ],
    });
    providerRuntimeMocks.loadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      loginOpenAICodexOAuth: providerRuntimeMocks.runFacadeOAuth,
    });
  });

  it("delegates OAuth login to the OpenAI provider auth hook", async () => {
    const credential = createCredential();
    const prompter = createPrompter();
    const runtime = createRuntime();
    const openUrl = vi.fn(async () => {});
    const controller = new AbortController();
    const onManualCodeInput = vi.fn(async () => "manual-code");
    providerRuntimeMocks.runOAuth.mockResolvedValueOnce({
      profiles: [{ profileId: "openai:user@example.com", credential }],
    });

    const result = await loginOpenAICodexOAuth({
      prompter,
      runtime,
      isRemote: true,
      openUrl,
      signal: controller.signal,
      onManualCodeInput,
      localBrowserMessage: "Complete sign-in in browser...",
    });

    expect(result).toEqual(credential);
    expect(providerRuntimeMocks.runOAuth).toHaveBeenCalledOnce();
    expect(
      providerRuntimeMocks.loadActivatedBundledPluginPublicSurfaceModuleSync,
    ).not.toHaveBeenCalled();
    expect(providerRuntimeMocks.runOAuth).toHaveBeenCalledWith({
      config: {},
      prompter,
      runtime,
      isRemote: true,
      openUrl,
      signal: controller.signal,
      onManualCodeInput,
      oauth: {
        createVpsAwareHandlers: expect.any(Function),
      },
    });
  });

  it("returns null when the provider hook does not create an OAuth credential", async () => {
    providerRuntimeMocks.runOAuth.mockResolvedValueOnce({ profiles: [] });

    await expect(
      loginOpenAICodexOAuth({
        prompter: createPrompter(),
        runtime: createRuntime(),
        isRemote: false,
        openUrl: async () => {},
      }),
    ).resolves.toBeNull();
  });

  it("falls back to the OpenAI plugin facade when the provider hook is unavailable", async () => {
    const credential = {
      access: "facade-access-token",
      refresh: "facade-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct_facade",
    };
    const prompter = createPrompter();
    const runtime = createRuntime();
    const openUrl = vi.fn(async () => {});
    const controller = new AbortController();
    const onManualCodeInput = vi.fn(async () => "manual-code");
    providerRuntimeMocks.resolveProviderRuntimePlugin.mockReturnValueOnce(undefined);
    providerRuntimeMocks.runFacadeOAuth.mockResolvedValueOnce(credential);

    const result = await loginOpenAICodexOAuth({
      prompter,
      runtime,
      isRemote: false,
      openUrl,
      signal: controller.signal,
      onManualCodeInput,
      localBrowserMessage: "Complete sign-in in browser...",
    });

    expect(result).toEqual(credential);
    expect(providerRuntimeMocks.runOAuth).not.toHaveBeenCalled();
    expect(
      providerRuntimeMocks.loadActivatedBundledPluginPublicSurfaceModuleSync,
    ).toHaveBeenCalledWith({
      dirName: "openai",
      artifactBasename: "api.js",
    });
    expect(providerRuntimeMocks.runFacadeOAuth).toHaveBeenCalledWith({
      prompter,
      runtime,
      isRemote: false,
      openUrl,
      signal: controller.signal,
      onManualCodeInput,
      localBrowserMessage: "Complete sign-in in browser...",
      oauth: {
        createVpsAwareHandlers: expect.any(Function),
      },
    });
  });

  it("preserves activated-facade failures when the OpenAI plugin is disabled", async () => {
    providerRuntimeMocks.resolveProviderRuntimePlugin.mockReturnValueOnce(undefined);
    providerRuntimeMocks.loadActivatedBundledPluginPublicSurfaceModuleSync.mockImplementationOnce(
      () => {
        throw new Error("plugin runtime is not activated");
      },
    );

    await expect(
      loginOpenAICodexOAuth({
        prompter: createPrompter(),
        runtime: createRuntime(),
        isRemote: false,
        openUrl: async () => {},
      }),
    ).rejects.toThrow("plugin runtime is not activated");
    expect(providerRuntimeMocks.runFacadeOAuth).not.toHaveBeenCalled();
  });
});
