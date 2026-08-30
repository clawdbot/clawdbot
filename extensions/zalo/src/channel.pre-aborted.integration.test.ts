// Zalo tests cover the configured gateway lifecycle through the real HTTP client.
import { createServer, type Server } from "node:http";
import {
  createEmptyPluginRegistry,
  createStartAccountContext,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setZaloRuntime, type OpenClawConfig, type PluginRuntime } from "../runtime-api.js";
import { resolveZaloAccount } from "./accounts.js";
import { zaloPlugin } from "./channel.js";

const originalZaloApiUrl = process.env.ZALO_API_URL;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback Zalo API address");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requireStartAccount() {
  const startAccount = zaloPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("expected Zalo gateway startAccount");
  }
  return startAccount;
}

describe("configured Zalo gateway with a pre-aborted lifecycle", () => {
  let server: Server;
  let apiMethods: string[];

  beforeEach(async () => {
    apiMethods = [];
    server = createServer((request, response) => {
      const method = request.url?.match(/\/bot[^/]+\/([^/?]+)/u)?.[1] ?? "unknown";
      apiMethods.push(method);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          result:
            method === "getMe"
              ? {
                  id: "loopback-bot",
                  account_name: "Loopback proof bot",
                  account_type: "BOT",
                  can_join_groups: false,
                }
              : { url: "" },
        }),
      );
    });
    process.env.ZALO_API_URL = await listen(server);
    setZaloRuntime({} as PluginRuntime);
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(async () => {
    if (originalZaloApiUrl === undefined) {
      delete process.env.ZALO_API_URL;
    } else {
      process.env.ZALO_API_URL = originalZaloApiUrl;
    }
    setActivePluginRegistry(createEmptyPluginRegistry());
    await close(server);
  });

  it.each([
    { mode: "polling", channel: { botToken: "test-bot-token" } },
    {
      mode: "webhook",
      channel: {
        botToken: "test-bot-token",
        webhookUrl: "https://example.invalid/hooks/zalo",
        webhookSecret: "test-webhook-secret",
      },
    },
  ] as const)("performs only the account probe in $mode mode", async ({ channel }) => {
    const cfg = { channels: { zalo: channel } } as OpenClawConfig;
    const account = resolveZaloAccount({ cfg });
    const abort = new AbortController();
    abort.abort();
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    await requireStartAccount()(
      createStartAccountContext({
        account,
        cfg,
        abortSignal: abort.signal,
      }),
    );

    expect(apiMethods).toEqual(["getMe"]);
    expect(registry.httpRoutes).toHaveLength(0);
  });
});
