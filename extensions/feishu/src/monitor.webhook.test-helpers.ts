import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { monitorFeishuProvider } from "./monitor.js";

const WEBHOOK_READY_MAX_ATTEMPTS = 200;
const WEBHOOK_READY_RETRY_DELAY_MS = 50;
const WEBHOOK_MONITOR_START_MAX_ATTEMPTS = 4;

export async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitUntilServerReady(url: string): Promise<void> {
  for (let i = 0; i < WEBHOOK_READY_MAX_ATTEMPTS; i += 1) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, WEBHOOK_READY_RETRY_DELAY_MS));
  }
  throw new Error(`server did not start: ${url}`);
}

export function buildWebhookConfig(params: {
  accountId: string;
  path: string;
  port: number;
  verificationToken?: string;
  encryptKey?: string;
}): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          [params.accountId]: {
            enabled: true,
            appId: "cli_test",
            appSecret: "secret_test", // pragma: allowlist secret
            connectionMode: "webhook",
            webhookHost: "127.0.0.1",
            webhookPort: params.port,
            webhookPath: params.path,
            encryptKey: params.encryptKey,
            verificationToken: params.verificationToken,
          },
        },
      },
    },
  } as ClawdbotConfig;
}

export async function withRunningWebhookMonitor(
  params: {
    accountId: string;
    path: string;
    verificationToken: string;
    encryptKey: string;
  },
  monitor: typeof monitorFeishuProvider,
  run: (url: string) => Promise<void>,
) {
  let startupError: unknown;
  for (let attempt = 1; attempt <= WEBHOOK_MONITOR_START_MAX_ATTEMPTS; attempt += 1) {
    const port = await getFreePort();
    const cfg = buildWebhookConfig({
      accountId: params.accountId,
      path: params.path,
      port,
      encryptKey: params.encryptKey,
      verificationToken: params.verificationToken,
    });

    const abortController = new AbortController();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const monitorPromise = monitor({
      config: cfg,
      runtime,
      abortSignal: abortController.signal,
      accountId: params.accountId,
    });

    const url = `http://127.0.0.1:${port}${params.path}`;
    try {
      await waitUntilServerReady(url);
      try {
        await run(url);
      } finally {
        abortController.abort();
        await monitorPromise.catch(() => undefined);
      }
      return;
    } catch (error) {
      startupError = error;
      abortController.abort();
      await monitorPromise.catch(() => undefined);
      if (attempt < WEBHOOK_MONITOR_START_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * WEBHOOK_READY_RETRY_DELAY_MS));
      }
    }
  }
  throw startupError instanceof Error ? startupError : new Error("failed to start webhook monitor");
}
