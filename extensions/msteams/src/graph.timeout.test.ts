// Msteams tests cover Graph token request deadlines.
import { afterEach, describe, expect, it, vi } from "vitest";

const sdkMock = vi.hoisted(() => ({
  acquire: vi.fn<(scope: string) => Promise<string>>(),
}));

vi.mock("./sdk.js", () => ({
  createMSTeamsTokenProvider() {
    return {
      async getAccessToken(scope: string) {
        return await sdkMock.acquire(scope);
      },
    };
  },
  async loadMSTeamsSdkWithAuth() {
    return { app: {} };
  },
}));

vi.mock("./token-response.js", () => ({
  readAccessToken(value: unknown) {
    return typeof value === "string" ? value : null;
  },
}));

vi.mock("./token.js", () => ({
  async resolveDelegatedAccessToken() {
    return undefined;
  },
  resolveMSTeamsCredentials() {
    return {
      type: "secret",
      appId: "app-id",
      appPassword: "test-app-password",
      tenantId: "tenant-id",
    };
  },
}));

import { resolveGraphToken } from "./graph.js";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "./request-timeout.js";

describe("resolveGraphToken request deadline", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("bounds stalled SDK token acquisition", async () => {
    sdkMock.acquire.mockImplementation(() => new Promise<string>(() => {}));
    vi.useFakeTimers();

    const result = resolveGraphToken({ channels: { msteams: {} } });
    const rejection = expect(result).rejects.toThrow(
      `MS Teams Graph token timed out after ${MSTEAMS_REQUEST_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(sdkMock.acquire).toHaveBeenCalledWith("https://graph.microsoft.com");
  });
});
