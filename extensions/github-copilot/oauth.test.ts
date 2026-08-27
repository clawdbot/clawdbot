import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { runGitHubCopilotDeviceFlow } from "./login.js";

const runDeviceFlow = vi.hoisted(() => vi.fn<typeof runGitHubCopilotDeviceFlow>());

vi.mock("./login.js", () => ({ runGitHubCopilotDeviceFlow: runDeviceFlow }));

import { loginGithubCopilotOAuth } from "./oauth.js";

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

  it("preserves a validated enterprise tenant on the returned credential", async () => {
    runDeviceFlow.mockResolvedValueOnce({
      status: "authorized",
      accessToken: "tenant-github-token",
    });

    await expect(
      loginGithubCopilotOAuth({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "https://acme.ghe.com"),
      }),
    ).resolves.toMatchObject({
      access: "tenant-github-token",
      refresh: "tenant-github-token",
      enterpriseUrl: "acme.ghe.com",
    });
    expect(runDeviceFlow).toHaveBeenCalledWith(expect.any(Object), "acme.ghe.com");
  });

  it("rejects an unsafe enterprise origin before starting the device flow", async () => {
    await expect(
      loginGithubCopilotOAuth({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "https://attacker.example"),
      }),
    ).rejects.toThrow("Unsupported GitHub Enterprise domain");
    expect(runDeviceFlow).not.toHaveBeenCalled();
  });
});
