import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

const probeBlueBubblesMock = vi.hoisted(() => vi.fn());
const cfg: OpenClawConfig = {};

vi.mock("./channel.runtime.js", () => ({
  blueBubblesChannelRuntime: {
    probeBlueBubbles: probeBlueBubblesMock,
  },
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

let bluebubblesPlugin: typeof import("./channel.js").bluebubblesPlugin;

describe("bluebubblesPlugin.status.probeAccount", () => {
  beforeAll(async () => {
    ({ bluebubblesPlugin } = await import("./channel.js"));
  });

  beforeEach(() => {
    probeBlueBubblesMock.mockReset();
    probeBlueBubblesMock.mockResolvedValue({ ok: true, status: 200 });
  });

  it("auto-enables private-network probes for loopback server URLs", async () => {
    await bluebubblesPlugin.status?.probeAccount?.({
      cfg,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        config: {
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
        baseUrl: "http://localhost:1234",
      },
      timeoutMs: 5000,
    });

    expect(probeBlueBubblesMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234",
      password: "test-password",
      timeoutMs: 5000,
      allowPrivateNetwork: true,
    });
  });

  it("respects an explicit private-network opt-out for loopback server URLs", async () => {
    await bluebubblesPlugin.status?.probeAccount?.({
      cfg,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        config: {
          serverUrl: "http://localhost:1234",
          password: "test-password",
          network: {
            dangerouslyAllowPrivateNetwork: false,
          },
        },
        baseUrl: "http://localhost:1234",
      },
      timeoutMs: 5000,
    });

    expect(probeBlueBubblesMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234",
      password: "test-password",
      timeoutMs: 5000,
      allowPrivateNetwork: false,
    });
  });
});
