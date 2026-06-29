// Github Copilot tests cover device-flow login behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runGitHubCopilotDeviceFlow,
  setGitHubCopilotDeviceFlowFetchGuardForTesting,
} from "./login.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

// A valid device code payload GitHub returns on the first step.
const VALID_DEVICE_CODE_BODY = {
  device_code: "dev-code-abc123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

function guardResponse(body: unknown, status = 200, url = DEVICE_CODE_URL) {
  return {
    response: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    finalUrl: url,
    release: vi.fn(async () => {}),
  };
}

afterEach(() => {
  setGitHubCopilotDeviceFlowFetchGuardForTesting(null);
  vi.restoreAllMocks();
});

describe("runGitHubCopilotDeviceFlow — normal flow", () => {
  it("returns authorized status and access token on successful flow", async () => {
    let callIdx = 0;
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async (params) => {
      callIdx += 1;
      if (callIdx === 1) {
        expect(params.url).toBe(DEVICE_CODE_URL);
        return guardResponse(VALID_DEVICE_CODE_BODY);
      }
      expect(params.url).toBe(ACCESS_TOKEN_URL);
      return guardResponse(
        { access_token: "ghu_tok_xyz", token_type: "bearer" },
        200,
        ACCESS_TOKEN_URL,
      );
    });

    const showCode = vi.fn(async () => {});
    const result = await runGitHubCopilotDeviceFlow({ showCode });

    expect(result).toEqual({ status: "authorized", accessToken: "ghu_tok_xyz" });
    expect(showCode).toHaveBeenCalledWith({
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      expiresInMs: expect.any(Number),
    });
    expect(callIdx).toBe(2);
  });

  it("returns access_denied when GitHub rejects the authorization", async () => {
    let callIdx = 0;
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async () => {
      callIdx += 1;
      if (callIdx === 1) {
        return guardResponse(VALID_DEVICE_CODE_BODY);
      }
      return guardResponse({ error: "access_denied" }, 200, ACCESS_TOKEN_URL);
    });

    const result = await runGitHubCopilotDeviceFlow({
      showCode: vi.fn(async () => {}),
    });
    expect(result).toEqual({ status: "access_denied" });
  });

  it("returns expired when GitHub reports expired_token", async () => {
    let callIdx = 0;
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async () => {
      callIdx += 1;
      if (callIdx === 1) {
        return guardResponse(VALID_DEVICE_CODE_BODY);
      }
      return guardResponse({ error: "expired_token" }, 200, ACCESS_TOKEN_URL);
    });

    const result = await runGitHubCopilotDeviceFlow({
      showCode: vi.fn(async () => {}),
    });
    expect(result).toEqual({ status: "expired" });
  });
});

describe("runGitHubCopilotDeviceFlow — HTTP error propagation", () => {
  it("throws with failureLabel on non-OK device code response", async () => {
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async () => guardResponse({}, 401));

    await expect(runGitHubCopilotDeviceFlow({ showCode: vi.fn() })).rejects.toThrow(
      "GitHub device code failed: HTTP 401",
    );
  });

  it("throws with failureLabel on non-OK access token response", async () => {
    let callIdx = 0;
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async () => {
      callIdx += 1;
      if (callIdx === 1) {
        return guardResponse(VALID_DEVICE_CODE_BODY);
      }
      return guardResponse({}, 500, ACCESS_TOKEN_URL);
    });

    await expect(runGitHubCopilotDeviceFlow({ showCode: vi.fn(async () => {}) })).rejects.toThrow(
      "GitHub device token failed: HTTP 500",
    );
  });
});

describe("postGitHubDeviceFlowForm — response size bound", () => {
  it("bounds oversized device code body and cancels the stream", async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB
    let readCount = 0;
    let canceled = false;
    // 64 chunks × 1 MiB = 64 MiB — far exceeds the 16 MiB cap
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount >= 64) {
          controller.close();
          return;
        }
        readCount += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });

    setGitHubCopilotDeviceFlowFetchGuardForTesting(async () => ({
      response: new Response(oversizedBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      finalUrl: DEVICE_CODE_URL,
      release: async () => {},
    }));

    await expect(runGitHubCopilotDeviceFlow({ showCode: vi.fn() })).rejects.toThrow(
      "github-copilot.device-flow",
    );

    // Stream must be cancelled before all 64 MiB are consumed
    expect(readCount).toBeLessThan(64);
    expect(canceled).toBe(true);
  });

  it("bounds oversized access token body and cancels the stream", async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB
    let readCount = 0;
    let canceled = false;
    let callIdx = 0;

    setGitHubCopilotDeviceFlowFetchGuardForTesting(async () => {
      callIdx += 1;
      if (callIdx === 1) {
        return guardResponse(VALID_DEVICE_CODE_BODY);
      }

      const oversizedBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (readCount >= 64) {
            controller.close();
            return;
          }
          readCount += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      });

      return {
        response: new Response(oversizedBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        finalUrl: ACCESS_TOKEN_URL,
        release: async () => {},
      };
    });

    await expect(runGitHubCopilotDeviceFlow({ showCode: vi.fn(async () => {}) })).rejects.toThrow(
      "github-copilot.device-flow",
    );

    // Stream must be cancelled before all 64 MiB are consumed
    expect(readCount).toBeLessThan(64);
    expect(canceled).toBe(true);
  });
});
