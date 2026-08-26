import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";

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
    vi.mocked(runtime.error).mockClear();
  });

  it.each([
    {
      name: "fresh remote configuration",
      baseConfig: {},
      expectedRemote: { url: remoteUrl, password: "replacement-password" },
    },
    {
      name: "a token SecretRef on the same endpoint",
      baseConfig: {
        gateway: {
          mode: "remote" as const,
          remote: {
            url: remoteUrl,
            token: { source: "env" as const, provider: "default", id: "OLD_REMOTE_TOKEN" },
            tlsFingerprint: "sha256:test-fingerprint",
            edgeAuth: { "X-Edge-Auth": "existing-edge-secret" },
          },
        },
      },
      expectedRemote: {
        url: remoteUrl,
        password: "replacement-password",
        tlsFingerprint: "sha256:test-fingerprint",
        edgeAuth: { "X-Edge-Auth": "existing-edge-secret" },
      },
    },
    {
      name: "credentials and routing from a different endpoint",
      baseConfig: {
        gateway: {
          mode: "remote" as const,
          remote: {
            url: "wss://old-gateway.example.test",
            token: { source: "env" as const, provider: "default", id: "OLD_REMOTE_TOKEN" },
            password: { source: "env" as const, provider: "default", id: "OLD_REMOTE_PASSWORD" },
            tlsFingerprint: "sha256:old-fingerprint",
            sshTarget: "operator@old-gateway.example.test",
            edgeAuth: { "X-Edge-Auth": "old-edge-secret" },
          },
        },
      },
      expectedRemote: { url: remoteUrl, password: "replacement-password" },
    },
  ])("stores a remote password while replacing $name", async ({ baseConfig, expectedRemote }) => {
    await runNonInteractiveRemoteSetup({
      opts: {
        nonInteractive: true,
        mode: "remote",
        remoteUrl,
        remotePassword: "replacement-password",
        skipHooks: true,
      },
      runtime,
      baseConfig,
    });

    const commit = commitNonInteractiveOnboardConfigMock.mock.calls[0]?.[0];
    expect(commit?.nextConfig.gateway?.remote).toEqual(expectedRemote);
  });

  it.each([
    {
      name: "token",
      option: "remoteToken" as const,
      field: "token" as const,
      envName: "OPENCLAW_GATEWAY_TOKEN",
      previousField: "password" as const,
    },
    {
      name: "password",
      option: "remotePassword" as const,
      field: "password" as const,
      envName: "OPENCLAW_GATEWAY_PASSWORD",
      previousField: "token" as const,
    },
  ])(
    "stores a remote $name as a configured-provider env reference and clears the old credential",
    async ({ option, field, envName, previousField }) => {
      await withEnvAsync({ [envName]: "replacement-credential" }, async () => {
        await runNonInteractiveRemoteSetup({
          opts: {
            nonInteractive: true,
            mode: "remote",
            remoteUrl,
            [option]: "replacement-credential",
            secretInputMode: "ref",
            skipHooks: true,
          },
          runtime,
          baseConfig: {
            secrets: {
              defaults: { env: "gatewayenv" },
              providers: { gatewayenv: { source: "env" } },
            },
            gateway: {
              mode: "remote",
              remote: {
                url: remoteUrl,
                [previousField]: {
                  source: "env",
                  provider: "default",
                  id: "OLD_GATEWAY_CREDENTIAL",
                },
                tlsFingerprint: "sha256:test-fingerprint",
              },
            },
          },
        });

        const commit = commitNonInteractiveOnboardConfigMock.mock.calls[0]?.[0];
        expect(commit?.nextConfig.gateway?.remote).toEqual({
          url: remoteUrl,
          [field]: { source: "env", provider: "gatewayenv", id: envName },
          tlsFingerprint: "sha256:test-fingerprint",
        });
      });
    },
  );

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
      opts: {
        nonInteractive: true,
        mode: "remote",
        remoteUrl,
        secretInputMode: "ref",
        skipHooks: true,
      },
      runtime,
      baseConfig: { gateway: { mode: "remote", remote } },
    });

    const commit = commitNonInteractiveOnboardConfigMock.mock.calls[0]?.[0];
    expect(commit?.nextConfig.gateway?.remote).toEqual(remote);
  });

  it("preserves endpoint-bound config when the remote URL has equivalent spelling", async () => {
    const existingRemote = {
      url: `${remoteUrl}/`,
      token: { source: "env" as const, provider: "default", id: "EXISTING_REMOTE_TOKEN" },
      tlsFingerprint: "sha256:test-fingerprint",
      sshTarget: "operator@gateway.example.test",
      edgeAuth: { "X-Edge-Auth": "existing-edge-secret" },
    };

    await runNonInteractiveRemoteSetup({
      opts: {
        nonInteractive: true,
        mode: "remote",
        remoteUrl,
        secretInputMode: "ref",
        skipHooks: true,
      },
      runtime,
      baseConfig: { gateway: { mode: "remote", remote: existingRemote } },
    });

    const commit = commitNonInteractiveOnboardConfigMock.mock.calls[0]?.[0];
    expect(commit?.nextConfig.gateway?.remote).toEqual({
      ...existingRemote,
      url: remoteUrl,
    });
  });

  it("preserves an existing remote password SecretRef when no replacement is provided", async () => {
    const remote = {
      url: remoteUrl,
      password: { source: "env" as const, provider: "default", id: "EXISTING_REMOTE_PASSWORD" },
      tlsFingerprint: "sha256:test-fingerprint",
    };

    await runNonInteractiveRemoteSetup({
      opts: {
        nonInteractive: true,
        mode: "remote",
        remoteUrl,
        secretInputMode: "ref",
        skipHooks: true,
      },
      runtime,
      baseConfig: { gateway: { mode: "remote", remote } },
    });

    const commit = commitNonInteractiveOnboardConfigMock.mock.calls[0]?.[0];
    expect(commit?.nextConfig.gateway?.remote).toEqual(remote);
  });

  it.each([
    {
      name: "an empty password",
      options: { remotePassword: " " },
      message: "Invalid --remote-password: value cannot be empty.",
    },
    {
      name: "simultaneous token and password credentials",
      options: { remoteToken: "remote-token", remotePassword: "remote-password" },
      message: "Use either --remote-token or --remote-password, not both.",
    },
  ])("rejects $name without committing remote configuration", async ({ options, message }) => {
    await expect(
      runNonInteractiveRemoteSetup({
        opts: { nonInteractive: true, mode: "remote", remoteUrl, skipHooks: true, ...options },
        runtime,
        baseConfig: {},
      }),
    ).rejects.toThrow("unexpected exit 1");

    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(commitNonInteractiveOnboardConfigMock).not.toHaveBeenCalled();
  });
});
