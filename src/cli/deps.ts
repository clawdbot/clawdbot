import { autoReplyIfConfigured } from "../auto-reply/reply.js";
import { readEnv } from "../env.js";
import { info } from "../globals.js";
import { ensureBinary } from "../infra/binaries.js";
import { ensurePortAvailable, handlePortError } from "../infra/ports.js";
import { ensureFunnel, getTailnetHostname } from "../infra/tailscale.js";
import { ensureMediaHosted } from "../media/host.js";
import {
  logWebSelfId,
  monitorWebProvider,
  sendMessageWeb,
} from "../providers/web/index.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { createClient } from "../twilio/client.js";
import { listRecentMessages } from "../twilio/messages.js";
import { monitorTwilio as monitorTwilioImpl } from "../twilio/monitor.js";
import { sendMessage, waitForFinalStatus } from "../twilio/send.js";
import { findWhatsappSenderSid } from "../twilio/senders.js";
import { assertProvider, sleep } from "../utils.js";
import { startWebhook } from "../webhook/server.js";
import { updateWebhook } from "../webhook/update.js";
import { waitForever } from "./wait.js";

export type CliDeps = {
  sendMessage: typeof sendMessage;
  sendMessageWeb: typeof sendMessageWeb;
  waitForFinalStatus: typeof waitForFinalStatus;
  assertProvider: typeof assertProvider;
  createClient?: typeof createClient;
  monitorTwilio: typeof monitorTwilio;
  listRecentMessages: typeof listRecentMessages;
  ensurePortAvailable: typeof ensurePortAvailable;
  startWebhook: typeof startWebhook;
  waitForever: typeof waitForever;
  ensureBinary: typeof ensureBinary;
  ensureFunnel: typeof ensureFunnel;
  getTailnetHostname: typeof getTailnetHostname;
  readEnv: typeof readEnv;
  findWhatsappSenderSid: typeof findWhatsappSenderSid;
  updateWebhook: typeof updateWebhook;
  handlePortError: typeof handlePortError;
  monitorWebProvider: typeof monitorWebProvider;
  resolveTwilioMediaUrl: (
    source: string,
    opts: { serveMedia: boolean; runtime: RuntimeEnv },
  ) => Promise<string>;
};

export async function monitorTwilio(
  intervalSeconds: number,
  lookbackMinutes: number,
  clientOverride?: ReturnType<typeof createClient>,
  maxIterations = Infinity,
) {
  // Adapter that wires default deps/runtime for the Twilio monitor loop.
  return monitorTwilioImpl(intervalSeconds, lookbackMinutes, {
    client: clientOverride,
    maxIterations,
    deps: {
      autoReplyIfConfigured,
      listRecentMessages,
      readEnv,
      createClient,
      sleep,
    },
    runtime: defaultRuntime,
  });
}

export function createDefaultDeps(): CliDeps {
  // Default dependency bundle used by CLI commands and tests.
  return {
    sendMessage,
    sendMessageWeb,
    waitForFinalStatus,
    assertProvider,
    createClient,
    monitorTwilio,
    listRecentMessages,
    ensurePortAvailable,
    startWebhook,
    waitForever,
    ensureBinary,
    ensureFunnel,
    getTailnetHostname,
    readEnv,
    findWhatsappSenderSid,
    updateWebhook,
    handlePortError,
    monitorWebProvider,
    resolveTwilioMediaUrl: async (source, { serveMedia, runtime }) => {
      if (/^https?:\/\//i.test(source)) return source;
      const hosted = await ensureMediaHosted(source, {
        startServer: serveMedia,
        runtime,
      });
      return hosted.url;
    },
  };
}

export function logTwilioFrom(runtime: RuntimeEnv = defaultRuntime) {
  // Log the configured Twilio sender for clarity in CLI output.
  const env = readEnv(runtime);
  runtime.log(
    info(`Provider: twilio (polling inbound) | from ${env.whatsappFrom}`),
  );
}

export { logWebSelfId };
