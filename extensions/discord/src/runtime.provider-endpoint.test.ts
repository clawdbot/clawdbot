// Discord tests prove endpoint initialization happens before the runtime becomes visible.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { initializeEndpointMock, setRuntimeStoreMock } = vi.hoisted(() => ({
  initializeEndpointMock: vi.fn(),
  setRuntimeStoreMock: vi.fn(),
}));

vi.mock("./provider-endpoint.js", () => ({
  initializeDiscordProviderEndpointFromEnv: initializeEndpointMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
  createPluginRuntimeStore: () => ({
    setRuntime: setRuntimeStoreMock,
    tryGetRuntime: vi.fn(),
    getRuntime: vi.fn(),
  }),
}));

import { setDiscordRuntime } from "./runtime.js";

describe("Discord provider endpoint runtime ordering", () => {
  beforeEach(() => {
    initializeEndpointMock.mockReset();
    setRuntimeStoreMock.mockReset();
  });

  it("initializes the endpoint before exposing the Discord runtime", () => {
    const runtime = {} as Parameters<typeof setDiscordRuntime>[0];

    setDiscordRuntime(runtime);

    expect(initializeEndpointMock).toHaveBeenCalledOnce();
    expect(setRuntimeStoreMock).toHaveBeenCalledWith(runtime);
    expect(initializeEndpointMock.mock.invocationCallOrder[0]).toBeLessThan(
      setRuntimeStoreMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not expose the Discord runtime when endpoint input is invalid", () => {
    const cachedError = new Error("invalid private endpoint input");
    initializeEndpointMock.mockImplementation(() => {
      throw cachedError;
    });

    const runtime = {} as Parameters<typeof setDiscordRuntime>[0];
    expect(() => setDiscordRuntime(runtime)).toThrow(cachedError);
    expect(() => setDiscordRuntime(runtime)).toThrow(cachedError);
    expect(initializeEndpointMock).toHaveBeenCalledTimes(2);
    expect(setRuntimeStoreMock).not.toHaveBeenCalled();
  });
});
