import { beforeEach, describe, expect, it, vi } from "vitest";

const createMatrixClientMock = vi.fn();
const isBunRuntimeMock = vi.fn(() => false);

vi.mock("./probe.runtime.js", () => ({
  createMatrixClient: (...args: unknown[]) => createMatrixClientMock(...args),
}));

vi.mock("./client/runtime.js", () => ({
  isBunRuntime: () => isBunRuntimeMock(),
}));

import { probeMatrix } from "./probe.js";

describe("probeMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isBunRuntimeMock.mockReturnValue(false);
    createMatrixClientMock.mockResolvedValue({
      getUserId: vi.fn(async () => "@bot:example.org"),
    });
  });

  it("passes undefined userId when not provided", async () => {
    const result = await probeMatrix({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      timeoutMs: 1234,
    });

    expect(result.ok).toBe(true);
    expect(createMatrixClientMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      userId: undefined,
      accessToken: "tok",
      persistStorage: false,
      localTimeoutMs: 1234,
    });
  });

  it("trims provided userId before client creation", async () => {
    await probeMatrix({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      userId: "  @bot:example.org  ",
      timeoutMs: 500,
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
      persistStorage: false,
      localTimeoutMs: 500,
    });
  });

  it("passes accountId through to client creation", async () => {
    await probeMatrix({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      userId: "@bot:example.org",
      timeoutMs: 500,
      accountId: "ops",
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
      persistStorage: false,
      localTimeoutMs: 500,
      accountId: "ops",
    });
  });

  it("passes dispatcherPolicy through to client creation", async () => {
    await probeMatrix({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      timeoutMs: 500,
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://127.0.0.1:7890",
      },
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      userId: undefined,
      accessToken: "tok",
      persistStorage: false,
      localTimeoutMs: 500,
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://127.0.0.1:7890",
      },
    });
  });

  it("passes deviceId through to client creation (#61317)", async () => {
    await probeMatrix({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      userId: "@bot:example.org",
      deviceId: "ABCDEF",
      timeoutMs: 500,
      accountId: "ops",
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
      deviceId: "ABCDEF",
      persistStorage: false,
      localTimeoutMs: 500,
      accountId: "ops",
    });
  });

  it("omits deviceId when not provided", async () => {
    await probeMatrix({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      timeoutMs: 500,
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      userId: undefined,
      accessToken: "tok",
      deviceId: undefined,
      persistStorage: false,
      localTimeoutMs: 500,
    });
  });

  it("returns client validation errors for insecure public http homeservers", async () => {
    createMatrixClientMock.mockRejectedValue(
      new Error("Matrix homeserver must use https:// unless it targets a private or loopback host"),
    );

    const result = await probeMatrix({
      homeserver: "http://matrix.example.org",
      accessToken: "tok",
      timeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Matrix homeserver must use https://");
  });
});
