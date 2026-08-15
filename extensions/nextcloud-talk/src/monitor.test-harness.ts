// Nextcloud Talk plugin module implements monitor harness behavior.
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";
import { createNextcloudTalkWebhookServer as createRawNextcloudTalkWebhookServer } from "./monitor.js";
import type { NextcloudTalkWebhookServerOptions } from "./types.js";
import { inspectNextcloudTalkWebhookEnvelope } from "./webhook-spool-state.js";

type WebhookHarness = {
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

type TestWebhookServerOptions = Omit<NextcloudTalkWebhookServerOptions, "onWebhook"> & {
  onWebhook?: NextcloudTalkWebhookServerOptions["onWebhook"];
  onMessage?: (rawBody: string) => void | Promise<void>;
};

type StartWebhookServerParams = Omit<
  TestWebhookServerOptions,
  "port" | "host" | "path" | "secret"
> & {
  path: string;
  secret?: string;
  host?: string;
  port?: number;
};

async function acceptLegacyTestWebhook(
  rawBody: string,
  onMessage?: StartWebhookServerParams["onMessage"],
): Promise<"accepted" | "ignored"> {
  if (!inspectNextcloudTalkWebhookEnvelope(rawBody)) {
    return "ignored";
  }
  await onMessage?.(rawBody);
  return "accepted";
}

function createNextcloudTalkWebhookServer(options: TestWebhookServerOptions) {
  const { onMessage, onWebhook, ...serverOptions } = options;
  return createRawNextcloudTalkWebhookServer({
    ...serverOptions,
    onWebhook: onWebhook ?? (async (rawBody) => await acceptLegacyTestWebhook(rawBody, onMessage)),
  });
}

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
