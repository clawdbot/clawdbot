// Whatsapp plugin module implements inbound admission retry behavior.
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { formatError } from "../session.js";
import { WhatsAppIngressPermanentError } from "./durable-payload.js";
import type { createWhatsAppIngressMonitor, WhatsAppIngressAdmission } from "./durable-receive.js";

const INBOUND_ADMISSION_RETRY_INITIAL_DELAY_MS = 1_000;
const INBOUND_ADMISSION_RETRY_MAX_DELAY_MS = 30_000;
export const WHATSAPP_INBOUND_ADMISSION_CUSTODY_LIMIT = 500;

type WhatsAppIngressMonitor = ReturnType<typeof createWhatsAppIngressMonitor>;
type AdmissionLogger = {
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
};

/**
 * Owns WhatsApp inbound custody after the shared monitor's quick append retries give up. Baileys
 * acks the stanza before `messages.upsert` fires, so nothing upstream can redeliver. Retries run
 * on a FIFO chain, so a waiting retry holds the chain and no later arrival overtakes an earlier
 * one, and custody is reserved per arriving batch so an outage cannot grow the process unbounded.
 */
export function createWhatsAppInboundAdmissionChain(
  monitor: WhatsAppIngressMonitor,
  logger: AdmissionLogger,
  consoleLog: { error: (message: string) => void },
) {
  const retryAbort = new AbortController();
  let tail: Promise<unknown> = Promise.resolve();
  let custody = 0;

  const reportDropped = (reason: string) => {
    logger.error({ error: reason }, "failed persisting durable WhatsApp inbound; message dropped");
    consoleLog.error(`Failed persisting durable WhatsApp inbound; dropped: ${reason}`);
  };

  return {
    /** Holds custody for a whole arriving batch; past the limit the batch is dropped unrun. */
    withCustody: async (count: number, deliver: () => Promise<void>) => {
      if (count > 0 && custody >= WHATSAPP_INBOUND_ADMISSION_CUSTODY_LIMIT) {
        reportDropped(
          `durable admission custody limit of ${WHATSAPP_INBOUND_ADMISSION_CUSTODY_LIMIT} inbound messages reached; dropped ${count} arriving inbound`,
        );
        return;
      }
      custody += count;
      try {
        await deliver();
      } finally {
        custody -= count;
      }
    },
    admitInArrivalOrder: (
      admission: WhatsAppIngressAdmission,
      receivedAt: number,
    ): Promise<Awaited<ReturnType<WhatsAppIngressMonitor["admit"]>> | undefined> => {
      const admitted = tail.then(async () => {
        let delayMs = INBOUND_ADMISSION_RETRY_INITIAL_DELAY_MS;
        for (;;) {
          try {
            return await monitor.admit(admission, { receivedAt });
          } catch (error) {
            const formattedError = formatError(error);
            if (
              error instanceof WhatsAppIngressPermanentError ||
              monitor.isStopped() ||
              retryAbort.signal.aborted
            ) {
              reportDropped(formattedError);
              return undefined;
            }
            logger.warn(
              { error: formattedError, retryDelayMs: delayMs },
              "failed persisting durable WhatsApp inbound; retrying admission",
            );
            await sleep(delayMs, retryAbort.signal).catch(() => undefined);
            delayMs = Math.min(delayMs * 2, INBOUND_ADMISSION_RETRY_MAX_DELAY_MS);
          }
        }
      });
      tail = admitted.catch(() => undefined);
      return admitted;
    },
    /** Aborts pending retries before stopping the monitor so close cannot hang. */
    stop: () => {
      retryAbort.abort();
      return monitor.stop();
    },
  };
}
