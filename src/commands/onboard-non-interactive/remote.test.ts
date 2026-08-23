import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const commitNonInteractiveOnboardConfigMock = vi.hoisted(() =>
  vi.fn(async (_params: { nextConfig: OpenClawConfig }) => undefined),
);

vi.mock("./config-write.js", () => ({
  commitNonInteractiveOnboardConfig: commitNonInteractiveOnboardConfigMock,
}));
vi.mock("../../config/logging.js", () => ({ logConfigUpdated: vi.fn() }));

const { runNonInteractiveRemoteSetup } = await import("./remote.js");

describe("runNonInteractiveRemoteSetup", () => {
  const runtime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code) => {
      throw new Error(`unexpected exit ${code}`);
    },
  };
  const remoteUrl = "wss://gateway.example.test";

  beforeEach(() => {
    commitNonInteractiveOnboardConfigMock.mockClear();
  });

  it("clears a stale password when a token replaces auth for the same endpoint", async () => {
    await runNonInteractiveRemoteSetup({
      opts: {
        nonInteractive: true,
        mode: "remote",
        remoteUrl,
        remoteToken: "replacement-token",
        skipHooks: true,
      },
      runtime,
      baseConfig: {
        gateway: {
          mode: "remote",
          remote: {
            url: remoteUrl,
            password: "old-password",
            tlsFingerprint: "sha256:test-fingerprint",
          },
        },
      },
    });

    const commit = commitNonInteractiveOnboardConfigMock.mock.calls[0]?.[0];
    expect(commit?.nextConfig.gateway?.remote).toEqual({
      url: remoteUrl,
      token: "replacement-token",
      tlsFingerprint: "sha256:test-fingerprint",
    });
  });

  it("preserves existing auth when no replacement token is provided", async () => {
    const remote = {
      url: remoteUrl,
      token: "existing-token",
      password: "existing-password",
    };

    await runNonInteractiveRemoteSetup({
      opts: { nonInteractive: true, mode: "remote", remoteUrl, skipHooks: true },
      runtime,
      baseConfig: { gateway: { mode: "remote", remote } },
    });

    const commit = commitNonInteractiveOnboardConfigMock.mock.calls[0]?.[0];
    expect(commit?.nextConfig.gateway?.remote).toEqual(remote);
  });
});
