import { type AddressInfo } from "node:net";
import { afterEach } from "vitest";
import { createNextcloudTalkWebhookServer } from "./monitor.js";
import type { NextcloudTalkWebhookServerOptions } from "./types.js";

export type WebhookHarness = {
  webhookUrl: string;
  stop: () => Promise<void>;
};

const cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupFns.length > 0) {
    const cleanup = cleanupFns.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

export type StartWebhookServerParams = Omit<
  NextcloudTalkWebhookServerOptions,
  "port" | "host" | "path" | "secret"
> & {
  path: string;
  secret?: string;
  host?: string;
  port?: number;
};

export async function startWebhookServer(
  params: StartWebhookServerParams,
): Promise<WebhookHarness> {
  const host = params.host ?? "127.0.0.1";
  const port = params.port ?? 0;
  const secret = params.secret ?? "nextcloud-secret";
  const { server, start } = createNextcloudTalkWebhookServer({
    ...params,
    port,
    host,
    secret,
  });
  await start();
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }

  const harness: WebhookHarness = {
    webhookUrl: `http://${host}:${address.port}${params.path}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  cleanupFns.push(harness.stop);
  return harness;
}
