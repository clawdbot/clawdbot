import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { runGitHubCopilotDeviceFlow } from "./login.js";

const runDeviceFlow = vi.hoisted(() => vi.fn<typeof runGitHubCopilotDeviceFlow>());

vi.mock("./login.js", () => ({ runGitHubCopilotDeviceFlow: runDeviceFlow }));

import { formatGithubCopilotApiKey, loginGithubCopilotOAuth } from "./oauth.js";

describe("github-copilot session OAuth adapter", () => {
  beforeEach(() => {
    runDeviceFlow.mockReset();
  });

  it("adapts the provider device flow to callback-based AuthStorage login", async () => {
    runDeviceFlow.mockImplementationOnce(async (io) => {
      await io.showCode({
        verificationUrl: "https://github.com/login/device",
        userCode: "ABCD-1234",
        expiresInMs: 60_000,
      });
      return { status: "authorized", accessToken: "durable-github-token" };
    });
    const onAuth = vi.fn();
    const onProgress = vi.fn();

    await expect(
      loginGithubCopilotOAuth({
        onAuth,
        onProgress,
        onPrompt: vi.fn(async () => ""),
      }),
    ).resolves.toEqual({
      access: "durable-github-token",
      refresh: "durable-github-token",
      expires: MAX_DATE_TIMESTAMP_MS,
    });
    expect(runDeviceFlow).toHaveBeenCalledWith(expect.any(Object), "github.com");
    expect(onAuth).toHaveBeenCalledWith({
      url: "https://github.com/login/device",
      instructions: "Enter code: ABCD-1234",
    });
    expect(onProgress).toHaveBeenCalledWith("Waiting for GitHub authorization...");
  });

  it.each([
    "https://acme.ghe.com",
    " HTTPS://ACME.GHE.COM/ ",
    "http://fixture-user@acme.ghe.com:443/path?q=1",
  ])("preserves a validated enterprise tenant from %s", async (input) => {
    runDeviceFlow.mockResolvedValueOnce({
      status: "authorized",
      accessToken: "tenant-github-token",
    });

    await expect(
      loginGithubCopilotOAuth({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => input),
      }),
    ).resolves.toMatchObject({
      access: "tenant-github-token",
      refresh: "tenant-github-token",
      enterpriseUrl: "acme.ghe.com",
    });
    expect(runDeviceFlow).toHaveBeenCalledWith(expect.any(Object), "acme.ghe.com");
  });

  it.each(["https://attacker.example", "https://[broken", "acme.ghe.com."])(
    "rejects unsupported enterprise input %s before device flow",
    async (input) => {
      await expect(
        loginGithubCopilotOAuth({
          onAuth: vi.fn(),
          onPrompt: vi.fn(async () => input),
        }),
      ).rejects.toThrow("Unsupported GitHub Enterprise domain");
      expect(runDeviceFlow).not.toHaveBeenCalled();
    },
  );
  it("keeps whitespace-only persisted enterprise metadata invalid when formatting a key", () => {
    expect(() =>
      formatGithubCopilotApiKey({ type: "oauth", refresh: "fixture", enterpriseUrl: "  " }),
    ).toThrow("Unsupported GitHub Enterprise domain");
  });
});
