import { sleep, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

const GATEWAY_RELOAD_WAIT_MS = 15_000;
const GATEWAY_RELOAD_POLL_MS = 500;

type BuzzStatusPayload = {
  channelAccounts?: Record<
    string,
    Array<{ accountId?: string; probe?: { ok?: boolean; rooms?: Array<{ id?: string }> } }>
  >;
};

type GatewayConfigPayload = {
  appliedConfigHash?: string | null;
  configRevisionHash?: string;
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
  accountId: string;
  target: string;
  runtime: RuntimeEnv;
}): Promise<void> {
  try {
    const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
    const reloadDeadline = Date.now() + GATEWAY_RELOAD_WAIT_MS;
    let reloadPending = false;
    while (true) {
      try {
        const configState = (await callGatewayFromCli(
          "config.get",
          { timeout: "5000", json: true },
          {},
          { expectFinal: false, progress: false },
        )) as GatewayConfigPayload;
        if (!configState.configRevisionHash) {
          throw new Error("Gateway config status did not include a saved revision hash");
        }
        if (configState.appliedConfigHash === configState.configRevisionHash) {
          break;
        }
        if (!reloadPending) {
          params.runtime.log("Buzz config saved. Waiting for the Gateway to apply it...");
          reloadPending = true;
        }
      } catch (error) {
        // A listener handoff is expected only after the Gateway has confirmed
        // that the saved revision is newer than its active runtime revision.
        if (!reloadPending || !isGatewayNotRunningError(error)) {
          throw error;
        }
      }
      const remainingMs = reloadDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Gateway did not apply the saved Buzz configuration within ${GATEWAY_RELOAD_WAIT_MS / 1000} seconds`,
        );
      }
      await sleep(Math.min(GATEWAY_RELOAD_POLL_MS, remainingMs));
    }
    const status = await callGatewayFromCli(
      "channels.status",
      { timeout: "15000", json: true },
      { channel: "buzz", probe: true, timeoutMs: 10_000 },
      { expectFinal: false, progress: false },
    );
    if (!hasSuccessfulBuzzProbe(status, params.accountId, params.target)) {
      params.runtime.log(
        `Buzz config was saved and applied, but the Gateway did not confirm authenticated membership in ${params.target}. Run \`openclaw channels status --probe\` before sending.`,
      );
      return;
    }
    params.runtime.log(
      "Buzz authenticated successfully and the configured room membership is visible.",
    );
  } catch (error) {
    if (isGatewayNotRunningError(error)) {
      params.runtime.log("Buzz config was saved. Start OpenClaw to connect: openclaw gateway");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    params.runtime.log(
      `Buzz config was saved, but post-setup verification did not complete: ${message}. Run \`openclaw channels status --probe\` after the Gateway reloads.`,
    );
  }
}
