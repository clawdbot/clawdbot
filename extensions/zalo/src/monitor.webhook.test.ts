import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import type { ClawdbotConfig, PluginRuntime } from "clawdbot/plugin-sdk";
import type { ResolvedZaloAccount } from "./types.js";
import { handleZaloWebhookRequest, registerZaloWebhookTarget } from "./monitor.js";

async function withServer(
  handler: Parameters<typeof createServer>[0],
  fn: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("missing server address");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("handleZaloWebhookRequest", () => {
  it("returns 400 for non-object payloads", async () => {
    const core = {} as PluginRuntime;
    const account: ResolvedZaloAccount = {
      accountId: "default",
      enabled: true,
      token: "tok",
      tokenSource: "config",
      config: {},
    };
    const unregister = registerZaloWebhookTarget({
      token: "tok",
      account,
      config: {} as ClawdbotConfig,
      runtime: {},
      core,
      secret: "secret",
      path: "/hook",
      mediaMaxMb: 5,
    });

    try {
      await withServer(async (req, res) => {
        const handled = await handleZaloWebhookRequest(req, res);
        if (!handled) {
          res.statusCode = 404;
          res.end("not found");
        }
      }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
          },
          body: "null",
        });

        expect(response.status).toBe(400);
      });
    } finally {
      unregister();
    }
  });
});
