// OpenAI ChatGPT OAuth tests cover login, token refresh, and auth persistence.
import { beforeEach, describe, expect, it, vi } from "vitest";

type LoginOpenAICodexOAuth =
  typeof import("../../../plugins/provider-openai-chatgpt-oauth.js").loginOpenAICodexOAuth;

const mocks = vi.hoisted(() => ({
  loginOpenAICodexOAuth: vi.fn<LoginOpenAICodexOAuth>(),
  loadActivatedBundledPluginPublicSurfaceModuleSync: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(),
}));

vi.mock("../../../plugins/provider-openai-chatgpt-oauth.js", () => ({
  loginOpenAICodexOAuth: mocks.loginOpenAICodexOAuth,
}));

vi.mock("../../../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin: mocks.refreshProviderOAuthCredentialWithPlugin,
}));

vi.mock("../../../plugin-sdk/facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync:
    mocks.loadActivatedBundledPluginPublicSurfaceModuleSync,
}));

import { openaiCodexOAuthProvider } from "./openai-chatgpt.js";

type OpenAIProviderLoginCallbacks = Omit<
  Parameters<typeof openaiCodexOAuthProvider.login>[0],
  "onAuth"
> & {
  onAuth: (
    info: Parameters<Parameters<typeof openaiCodexOAuthProvider.login>[0]["onAuth"]>[0],
  ) => Promise<void> | void;
};

async function loginThroughOpenAIProvider(callbacks: OpenAIProviderLoginCallbacks) {
  return await openaiCodexOAuthProvider.login(
    callbacks as Parameters<typeof openaiCodexOAuthProvider.login>[0],
  );
}

async function refreshThroughOpenAIProvider(refreshToken: string) {
  return await openaiCodexOAuthProvider.refreshToken({
    access: "expired-access-token",
    refresh: refreshToken,
    expires: 0,
  });
}

function createCredential() {
  return {
    type: "oauth" as const,
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: 1_700_000_000_000,
    accountId: "acct_123",
  };
}

describe("OpenAI Codex OAuth compatibility provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      refreshOpenAICodexToken: mocks.refreshOpenAICodexToken,
    });
  });

  it("routes legacy login callbacks through the OpenAI provider auth hook", async () => {
    const credential = createCredential();
    const onAuth = vi.fn();
    const onPrompt = vi.fn(async () => "manual-code");
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      await params.openUrl("https://auth.openai.com/oauth/authorize?state=abc");
      await expect(params.prompter.text({ message: "Paste code" })).resolves.toBe("manual-code");
      return credential;
    });

    await expect(loginThroughOpenAIProvider({ onAuth, onPrompt })).resolves.toEqual(credential);

    expect(onAuth).toHaveBeenCalledWith({
      url: "https://auth.openai.com/oauth/authorize?state=abc",
    });
    expect(onPrompt).toHaveBeenCalledWith({ message: "Paste code", placeholder: undefined });
    expect(mocks.loginOpenAICodexOAuth).toHaveBeenCalledWith({
      prompter: expect.any(Object),
      runtime: expect.any(Object),
      isRemote: false,
      signal: undefined,
      onManualCodeInput: undefined,
      openUrl: expect.any(Function),
    });
  });

  it("waits for the auth URL to render before requesting manual input", async () => {
    let finishAuth!: () => void;
    const authRendered = new Promise<void>((resolve) => {
      finishAuth = resolve;
    });
    const onAuth = vi.fn(async () => authRendered);
    const onPrompt = vi.fn(async () => "manual-code");
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      await params.openUrl("https://auth.openai.com/oauth/authorize?state=abc");
      await params.prompter.text({ message: "Paste code" });
      return createCredential();
    });

    const login = loginThroughOpenAIProvider({ onAuth, onPrompt });
    await vi.waitFor(() => expect(onAuth).toHaveBeenCalledOnce());
    expect(onPrompt).not.toHaveBeenCalled();

    finishAuth();
    await expect(login).resolves.toEqual(createCredential());
    expect(onPrompt).toHaveBeenCalledOnce();
  });

  it("passes legacy manual input through so it starts alongside browser auth", async () => {
    const onManualCodeInput = vi.fn(async () => "manual-code");
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      await expect(params.onManualCodeInput?.()).resolves.toBe("manual-code");
      await expect(params.prompter.text({ message: "Fallback code" })).resolves.toBe(
        "fallback-code",
      );
      return createCredential();
    });

    await expect(
      loginThroughOpenAIProvider({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "fallback-code"),
        onManualCodeInput,
      }),
    ).resolves.toEqual(createCredential());

    expect(onManualCodeInput).toHaveBeenCalledOnce();
  });

  it("honors legacy login cancellation before opening OAuth", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      loginThroughOpenAIProvider({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "manual-code"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Login cancelled");
    expect(mocks.loginOpenAICodexOAuth).not.toHaveBeenCalled();
  });

  it("passes legacy cancellation into the provider auth hook", async () => {
    const controller = new AbortController();
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      expect(params.signal).toBe(controller.signal);
      controller.abort();
      await expect(params.onManualCodeInput?.()).rejects.toThrow("Login cancelled");
      return createCredential();
    });

    await expect(
      loginThroughOpenAIProvider({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "manual-code"),
        onManualCodeInput: vi.fn(async () => "manual-code"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Login cancelled");
  });

  it("honors legacy login cancellation before invoking the auth callback", async () => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      controller.abort();
      await params.openUrl("https://auth.openai.com/oauth/authorize?state=abc");
      return createCredential();
    });

    await expect(
      loginThroughOpenAIProvider({
        onAuth,
        onPrompt: vi.fn(async () => "manual-code"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Login cancelled");
    expect(onAuth).not.toHaveBeenCalled();
  });

  it("refreshes through the provider runtime hook without returning auth-profile fields", async () => {
    mocks.refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(createCredential());

    await expect(refreshThroughOpenAIProvider("old-refresh-token")).resolves.toEqual({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_700_000_000_000,
      accountId: "acct_123",
    });

    expect(mocks.refreshProviderOAuthCredentialWithPlugin).toHaveBeenCalledWith({
      provider: "openai",
      context: {
        type: "oauth",
        provider: "openai",
        access: "",
        refresh: "old-refresh-token",
        expires: 0,
      },
    });
    expect(mocks.loadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("falls back to the OpenAI plugin facade when provider runtime refresh is unavailable", async () => {
    const credential = {
      access: "facade-access-token",
      refresh: "facade-refresh-token",
      expires: 1_700_000_000_000,
      accountId: "acct_facade",
    };
    mocks.refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(null);
    mocks.refreshOpenAICodexToken.mockResolvedValueOnce(credential);

    await expect(refreshThroughOpenAIProvider("old-refresh-token")).resolves.toEqual(credential);

    expect(mocks.loadActivatedBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "openai",
      artifactBasename: "api.js",
    });
    expect(mocks.refreshOpenAICodexToken).toHaveBeenCalledWith("old-refresh-token");
  });

  it("preserves activated-facade failures when refresh fallback is disabled", async () => {
    mocks.refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(null);
    mocks.loadActivatedBundledPluginPublicSurfaceModuleSync.mockImplementationOnce(() => {
      throw new Error("plugin runtime is not activated");
    });

    await expect(refreshThroughOpenAIProvider("old-refresh-token")).rejects.toThrow(
      "plugin runtime is not activated",
    );
    expect(mocks.refreshOpenAICodexToken).not.toHaveBeenCalled();
  });
});
