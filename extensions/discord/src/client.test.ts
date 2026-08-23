// Discord tests cover client plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordClient, createDiscordRestClient } from "./client.js";
import type { RequestClient } from "./internal/discord.js";
import type { GatewayPlugin } from "./internal/gateway.js";
import { clearGateways, registerGateway } from "./monitor/gateway-registry.js";

afterEach(() => {
  vi.unstubAllEnvs();
  clearGateways();
});

describe("createDiscordClient", () => {
  it("extends a single REST operation after the registered gateway disconnects", async () => {
    registerGateway("default", { isConnected: false } as GatewayPlugin);
    const request = createDiscordClient({
      cfg: {
        channels: {
          discord: {
            token: "discord-token",
          },
        },
      },
      rest: {} as RequestClient,
    }).request;
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("sent");

    await expect(request(operation, "send")).resolves.toBe("sent");
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

describe("createDiscordRestClient", () => {
  const fakeRest = {} as RequestClient;

  it("uses explicit token without resolving config token SecretRefs", () => {
    const cfg = {
      channels: {
        discord: {
          token: {
            source: "exec",
            provider: "vault",
            id: "discord/bot-token",
          },
        },
      },
    } as OpenClawConfig;

    const result = createDiscordRestClient({ cfg, token: "Bot explicit-token", rest: fakeRest });

    expect(result.token).toBe("explicit-token");
    expect(result.rest).toBe(fakeRest);
    expect(result.account.accountId).toBe("default");
  });

  it("applies a caller timeout to a dedicated REST client", () => {
    const cfg = { channels: { discord: { token: "discord-token" } } } as OpenClawConfig;

    const result = createDiscordRestClient({ cfg, timeoutMs: 250 });

    expect(result.rest.options.timeout).toBe(250);
  });

  it("still fails closed when no explicit token is provided and config token is unresolved", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        discord: {
          token: {
            source: "file",
            provider: "default",
            id: "/discord/token",
          },
        },
      },
    } as OpenClawConfig;

    expect(() => createDiscordRestClient({ cfg, rest: fakeRest })).toThrow(
      /configured for account "default" is unavailable/i,
    );
  });
});
