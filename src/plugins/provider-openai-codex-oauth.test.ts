import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn(),
  runOpenAIOAuthTlsPreflight: vi.fn(),
  formatOpenAIOAuthTlsPreflightFix: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    loginOpenAICodex: mocks.loginOpenAICodex,
  };
});

vi.mock("./provider-openai-codex-oauth-tls.js", () => ({
  runOpenAIOAuthTlsPreflight: mocks.runOpenAIOAuthTlsPreflight,
  formatOpenAIOAuthTlsPreflightFix: mocks.formatOpenAIOAuthTlsPreflightFix,
}));

import { loginOpenAICodexOAuth } from "./provider-openai-codex-oauth.js";

const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize?state=abc";

type CodexLoginOptions = {
  onAuth: (event: { url: string }) => Promise<void>;
  onManualCodeInput?: () => Promise<string>;
};

function createPrompter() {
  const spin = { update: vi.fn(), stop: vi.fn() };
  const prompter: Pick<WizardPrompter, "note" | "progress" | "text"> = {
    note: vi.fn(async () => {}),
    progress: vi.fn(() => spin),
    text: vi.fn(async () => "http://localhost:1455/auth/callback?code=test"),
  };
  return { prompter: prompter as unknown as WizardPrompter, spin };
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

function createCodexCredentials(extra: Record<string, unknown> = {}) {
  return {
    provider: "openai-codex" as const,
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    email: "user@example.com",
    ...extra,
  };
}

async function startCodexAuth(opts: CodexLoginOptions) {
  await opts.onAuth({ url: CODEX_AUTHORIZE_URL });
  expect(opts.onManualCodeInput).toBeTypeOf("function");
}

async function runCodexOAuth(params: {
  isRemote: boolean;
  openUrl?: (url: string) => Promise<void>;
}) {
  const { prompter, spin } = createPrompter();
  const runtime = createRuntime();
  const result = await loginOpenAICodexOAuth({
    prompter,
    runtime,
    isRemote: params.isRemote,
    openUrl: params.openUrl ?? (async () => {}),
  });
  return { result, prompter, spin, runtime };
}

describe("loginOpenAICodexOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({ ok: true });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("tls fix");
  });

  it("returns credentials on successful oauth login", async () => {
    const creds = createCodexCredentials();
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { result, spin, runtime } = await runCodexOAuth({ isRemote: false });

    expect(result).toEqual(creds);
    expect(mocks.loginOpenAICodex).toHaveBeenCalledOnce();
    expect(mocks.loginOpenAICodex).toHaveBeenCalledWith(
      expect.objectContaining({ originator: "openclaw" }),
    );
    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth complete");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("passes through Pi-provided authorize URLs without mutation", async () => {
    const creds = createCodexCredentials();
    mocks.loginOpenAICodex.mockImplementation(
      async (opts: { onAuth: (event: { url: string }) => Promise<void> }) => {
        await opts.onAuth({
          url: "https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access&state=abc",
        });
        return creds;
      },
    );

    const openUrl = vi.fn(async () => {});
    const { runtime } = await runCodexOAuth({ isRemote: false, openUrl });

    expect(openUrl).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access&state=abc",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Open: https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access&state=abc",
    );
  });

  it("preserves authorize urls that omit scope", async () => {
    const creds = createCodexCredentials();
    mocks.loginOpenAICodex.mockImplementation(
      async (opts: { onAuth: (event: { url: string }) => Promise<void> }) => {
        await opts.onAuth({ url: CODEX_AUTHORIZE_URL });
        return creds;
      },
    );

    const openUrl = vi.fn(async () => {});
    await runCodexOAuth({ isRemote: false, openUrl });

    expect(openUrl).toHaveBeenCalledWith(CODEX_AUTHORIZE_URL);
  });

  it("preserves slash-terminated authorize paths too", async () => {
    const creds = createCodexCredentials();
    mocks.loginOpenAICodex.mockImplementation(
      async (opts: { onAuth: (event: { url: string }) => Promise<void> }) => {
        await opts.onAuth({
          url: "https://auth.openai.com/oauth/authorize/?state=abc",
        });
        return creds;
      },
    );

    const openUrl = vi.fn(async () => {});
    await runCodexOAuth({ isRemote: false, openUrl });

    expect(openUrl).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize/?state=abc");
  });

  it("reports oauth errors and rethrows", async () => {
    mocks.loginOpenAICodex.mockRejectedValue(new Error("oauth failed"));

    const { prompter, spin } = createPrompter();
    const runtime = createRuntime();
    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: true,
        openUrl: async () => {},
      }),
    ).rejects.toThrow("oauth failed");

    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth failed");
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("oauth failed"));
    expect(prompter.note).toHaveBeenCalledWith(
      "Trouble with OAuth? See https://docs.openclaw.ai/start/faq",
      "OAuth help",
    );
  });

  it("passes manual code input hook for remote oauth flows", async () => {
    const creds = createCodexCredentials();
    mocks.loginOpenAICodex.mockImplementation(async (opts: CodexLoginOptions) => {
      await startCodexAuth(opts);
      await expect(opts.onManualCodeInput?.()).resolves.toContain("code=test");
      return creds;
    });

    const { result, prompter } = await runCodexOAuth({ isRemote: true });

    expect(result).toEqual(creds);
    expect(prompter.text).toHaveBeenCalledWith({
      message: "Paste the authorization code (or full redirect URL):",
      validate: expect.any(Function),
    });
  });

  it("waits briefly before prompting for manual input after the local browser flow starts", async () => {
    vi.useFakeTimers();
    const { prompter } = createPrompter();
    const runtime = createRuntime();
    mocks.loginOpenAICodex.mockImplementation(async (opts: CodexLoginOptions) => {
      await startCodexAuth(opts);
      const manualPromise = opts.onManualCodeInput?.();
      await vi.advanceTimersByTimeAsync(14_000);
      expect(manualPromise).toBeDefined();
      expect(prompter.text).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(prompter.text).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      return createCodexCredentials({ manualCode: await manualPromise });
    });

    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: false,
        openUrl: async () => {},
      }),
    ).resolves.toMatchObject({
      access: "access-token",
      refresh: "refresh-token",
    });

    expect(prompter.text).toHaveBeenCalledWith({
      message: "Paste the authorization code (or full redirect URL):",
      validate: expect.any(Function),
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "OpenAI Codex OAuth callback did not arrive within 15000ms; switching to manual entry (callback_timeout).",
    );
    vi.useRealTimers();
  });

  it("clears the local manual fallback timer when browser callback settles first", async () => {
    vi.useFakeTimers();
    mocks.loginOpenAICodex.mockImplementation(async (opts: CodexLoginOptions) => {
      await startCodexAuth(opts);
      void opts.onManualCodeInput?.();
      return createCodexCredentials();
    });

    await expect(runCodexOAuth({ isRemote: false })).resolves.toMatchObject({
      result: expect.objectContaining({
        access: "access-token",
        refresh: "refresh-token",
      }),
    });

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("continues OAuth flow on non-certificate preflight failures", async () => {
    const creds = createCodexCredentials();
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "network",
      message: "Client network socket disconnected before secure TLS connection was established",
    });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { result, prompter, runtime } = await runCodexOAuth({ isRemote: false });

    expect(result).toEqual(creds);
    expect(mocks.loginOpenAICodex).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalledWith("tls fix");
    expect(prompter.note).not.toHaveBeenCalledWith("tls fix", "OAuth prerequisites");
  });

  it("fails fast on TLS certificate preflight failures before starting OAuth login", async () => {
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("Run brew postinstall openssl@3");
    const creds = createCodexCredentials();
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { prompter } = createPrompter();
    const runtime = createRuntime();

    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: false,
        openUrl: async () => {},
      }),
    ).rejects.toThrow(/OAuth prerequisites/i);

    expect(mocks.loginOpenAICodex).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(
      "Run brew postinstall openssl@3",
      "OAuth prerequisites",
    );
  });

  it("prompts for manual input immediately when the local callback flow never starts", async () => {
    vi.useFakeTimers();
    const { prompter } = createPrompter();
    const runtime = createRuntime();
    mocks.loginOpenAICodex.mockImplementation(
      async (opts: { onManualCodeInput?: () => Promise<string> }) => {
        expect(opts.onManualCodeInput).toBeTypeOf("function");
        const manualCode = await opts.onManualCodeInput?.();
        return createCodexCredentials({ manualCode });
      },
    );

    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: false,
        openUrl: async () => {},
      }),
    ).resolves.toMatchObject({
      access: "access-token",
      refresh: "refresh-token",
    });

    expect(prompter.text).toHaveBeenCalledWith({
      message: "Paste the authorization code (or full redirect URL):",
      validate: expect.any(Function),
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("suppresses the local manual prompt when oauth settles just after the fallback deadline", async () => {
    vi.useFakeTimers();
    const { prompter } = createPrompter();
    const runtime = createRuntime();
    mocks.loginOpenAICodex.mockImplementation(async (opts: CodexLoginOptions) => {
      await startCodexAuth(opts);
      void opts.onManualCodeInput?.();
      await vi.advanceTimersByTimeAsync(15_500);
      return createCodexCredentials();
    });

    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: false,
        openUrl: async () => {},
      }),
    ).resolves.toMatchObject({
      access: "access-token",
      refresh: "refresh-token",
    });

    expect(prompter.text).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("rewrites callback validation failures with a stable internal code", async () => {
    mocks.loginOpenAICodex.mockRejectedValue(new Error("State mismatch"));

    const { prompter, spin } = createPrompter();
    const runtime = createRuntime();
    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: false,
        openUrl: async () => {},
      }),
    ).rejects.toThrow(/callback_validation_failed/i);

    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth failed");
  });
});
