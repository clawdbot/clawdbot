import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ConnectErrorDetailCodes } from "../gateway/protocol/connect-error-details.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  handleNodeHostReconnectPaused,
  resolveNodeHostGatewayCredentials,
  shouldExitNodeHostOnReconnectPaused,
} from "./runner.js";

function createRemoteGatewayTokenRefConfig(tokenId: string): OpenClawConfig {
  return {
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
    gateway: {
      mode: "remote",
      remote: {
        token: { source: "env", provider: "default", id: tokenId },
      },
    },
  } as OpenClawConfig;
}

async function expectNoGatewayCredentials(
  config: OpenClawConfig,
  env: Record<string, string | undefined>,
) {
  await withEnvAsync(env, async () => {
    const credentials = await resolveNodeHostGatewayCredentials({ config });
    expect(credentials.token).toBeUndefined();
    expect(credentials.password).toBeUndefined();
  });
}

describe("resolveNodeHostGatewayCredentials", () => {
  it("does not inherit gateway.remote token in local mode", async () => {
    const config = {
      gateway: {
        mode: "local",
        remote: { token: "remote-only-token" },
      },
    } as OpenClawConfig;

    await expectNoGatewayCredentials(config, {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    });
  });

  it("ignores unresolved gateway.remote token refs in local mode", async () => {
    const config = {
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      gateway: {
        mode: "local",
        remote: {
          token: { source: "env", provider: "default", id: "MISSING_REMOTE_GATEWAY_TOKEN" },
        },
      },
    } as OpenClawConfig;

    await expectNoGatewayCredentials(config, {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      MISSING_REMOTE_GATEWAY_TOKEN: undefined,
    });
  });

  it("resolves remote token SecretRef values", async () => {
    const config = createRemoteGatewayTokenRefConfig("REMOTE_GATEWAY_TOKEN");

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        REMOTE_GATEWAY_TOKEN: "token-from-ref",
      },
      async () => {
        const credentials = await resolveNodeHostGatewayCredentials({ config });
        expect(credentials.token).toBe("token-from-ref");
      },
    );
  });

  it("prefers OPENCLAW_GATEWAY_TOKEN over configured refs", async () => {
    const config = createRemoteGatewayTokenRefConfig("REMOTE_GATEWAY_TOKEN");

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "token-from-env",
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        REMOTE_GATEWAY_TOKEN: "token-from-ref",
      },
      async () => {
        const credentials = await resolveNodeHostGatewayCredentials({ config });
        expect(credentials.token).toBe("token-from-env");
      },
    );
  });

  it("throws when a configured remote token ref cannot resolve", async () => {
    const config = createRemoteGatewayTokenRefConfig("MISSING_REMOTE_GATEWAY_TOKEN");

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        MISSING_REMOTE_GATEWAY_TOKEN: undefined,
      },
      async () => {
        await expect(resolveNodeHostGatewayCredentials({ config })).rejects.toThrow(
          "gateway.remote.token",
        );
      },
    );
  });

  it("does not resolve remote password refs when token auth is already available", async () => {
    const config = {
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      gateway: {
        mode: "remote",
        remote: {
          token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
          password: { source: "env", provider: "default", id: "MISSING_REMOTE_GATEWAY_PASSWORD" },
        },
      },
    } as OpenClawConfig;

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        REMOTE_GATEWAY_TOKEN: "token-from-ref",
        MISSING_REMOTE_GATEWAY_PASSWORD: undefined,
      },
      async () => {
        const credentials = await resolveNodeHostGatewayCredentials({ config });
        expect(credentials.token).toBe("token-from-ref");
        expect(credentials.password).toBeUndefined();
      },
    );
  });
});

describe("handleNodeHostReconnectPaused", () => {
  it("exits for terminal credential pauses so service supervisors can restart", () => {
    const lines: string[] = [];
    const exit = vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never;

    expect(() =>
      handleNodeHostReconnectPaused(
        {
          code: 1008,
          reason: "connect failed",
          detailCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
        },
        { writeLine: (line) => lines.push(line), exit },
      ),
    ).toThrow("exit 1");

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toEqual([
      "node host gateway reconnect paused after close (1008): connect failed detail=AUTH_TOKEN_MISMATCH; exiting for supervisor restart",
    ]);
  });

  it("keeps pairing pauses visible without exiting foreground approval flow", () => {
    const lines: string[] = [];
    const exit = vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never;

    handleNodeHostReconnectPaused(
      {
        code: 1008,
        reason: "connect failed",
        detailCode: ConnectErrorDetailCodes.PAIRING_REQUIRED,
      },
      { writeLine: (line) => lines.push(line), exit },
    );

    expect(shouldExitNodeHostOnReconnectPaused(ConnectErrorDetailCodes.PAIRING_REQUIRED)).toBe(
      false,
    );
    expect(exit).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "node host gateway reconnect paused after close (1008): connect failed detail=PAIRING_REQUIRED; waiting for operator action",
    ]);
  });
});
