import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

type BuzzStatusPayload = {
  channelAccounts?: Record<
    string,
    Array<{ accountId?: string; probe?: { ok?: boolean; rooms?: Array<{ id?: string }> } }>
  >;
};

function hasSuccessfulBuzzProbe(payload: unknown, accountId: string, target: string): boolean {
  const accounts = (payload as BuzzStatusPayload | undefined)?.channelAccounts?.buzz;
  return Boolean(
    accounts?.some(
      (account) =>
        account.accountId === accountId &&
        account.probe?.ok === true &&
        account.probe.rooms?.some((room) => room.id === target),
    ),
  );
}

function isGatewayNotRunningError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const identifiesMissingListener =
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("no listener");
  if (
    identifiesMissingListener &&
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "kind" in error &&
    "code" in error &&
    (error as { name?: unknown }).name === "GatewayTransportError" &&
    (error as { kind?: unknown }).kind === "closed" &&
    (error as { code?: unknown }).code === 1006
  ) {
    return true;
  }
  return identifiesMissingListener;
}

export async function verifyBuzzAfterSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  target: string;
  runtime: RuntimeEnv;
  sendTestMessage: boolean;
}): Promise<void> {
  try {
    const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
    const status = await callGatewayFromCli(
      "channels.status",
      { timeout: "15000", json: true },
      { channel: "buzz", probe: true, timeoutMs: 10_000 },
      { expectFinal: false, progress: false },
    );
    if (!hasSuccessfulBuzzProbe(status, params.accountId, params.target)) {
      params.runtime.log(
        `Buzz config was saved, but the Gateway did not confirm authenticated membership in ${params.target}. Wait for config reload, then run \`openclaw channels status --probe\` before sending.`,
      );
      return;
    }
    params.runtime.log(
      "Buzz authenticated successfully and the configured room membership is visible.",
    );
    if (!params.sendTestMessage) {
      return;
    }
    await callGatewayFromCli(
      "send",
      { timeout: "15000", json: true },
      {
        channel: "buzz",
        accountId: params.accountId,
        to: params.target,
        message: "OpenClaw Buzz setup test: the bot is connected.",
        idempotencyKey: randomUUID(),
      },
      { expectFinal: false, progress: false },
    );
    params.runtime.log(`Buzz test message sent to ${params.target}.`);
  } catch (error) {
    if (isGatewayNotRunningError(error)) {
      params.runtime.log("Buzz config was saved. Start OpenClaw to connect: openclaw gateway");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    params.runtime.log(
      `Buzz config was saved, but post-setup verification did not complete: ${message}. Run \`openclaw channels status --probe\`, then send a test message after the Gateway reloads.`,
    );
  }
}
