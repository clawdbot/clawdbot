// QA Lab WhatsApp auth archive and channel readiness setup.
import fs from "node:fs/promises";
import path from "node:path";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WhatsAppQaGateway } from "./whatsapp-live.contracts.js";

const WHATSAPP_QA_READY_TIMEOUT_MS = 150_000;
const WHATSAPP_QA_READY_STABILITY_MS = 20_000;
const WHATSAPP_QA_AUTH_ARCHIVE_TIMEOUT_MS = 60_000;
const WHATSAPP_QA_SIGNAL_SESSION_FILE_RE = /^session-[^/\\]+\.json$/u;

type WhatsAppChannelStatus = {
  busy?: boolean;
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: unknown;
  lastError?: string;
  lastRunActivityAt?: number | null;
  restartPending?: boolean;
  running?: boolean;
};

function isWhatsAppChannelReady(status: WhatsAppChannelStatus | undefined) {
  return (
    status?.running === true &&
    status.connected === true &&
    status.restartPending !== true &&
    status.busy !== true
  );
}

async function waitForWhatsAppChannelRunning(
  gateway: WhatsAppQaGateway,
  accountId: string,
): Promise<WhatsAppChannelStatus> {
  const startedAt = Date.now();
  let lastStatus: WhatsAppChannelStatus | undefined;
  while (Date.now() - startedAt < WHATSAPP_QA_READY_TIMEOUT_MS) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            busy?: boolean;
            connected?: boolean;
            lastConnectedAt?: number;
            lastDisconnect?: unknown;
            lastError?: string;
            lastRunActivityAt?: number | null;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.whatsapp ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastStatus = match
        ? {
            busy: match.busy,
            connected: match.connected,
            lastConnectedAt: match.lastConnectedAt,
            lastDisconnect: match.lastDisconnect,
            lastError: match.lastError,
            lastRunActivityAt: match.lastRunActivityAt,
            restartPending: match.restartPending,
            running: match.running,
          }
        : undefined;
      if (isWhatsAppChannelReady(lastStatus)) {
        if (!lastStatus) {
          throw new Error(
            `whatsapp account "${accountId}" status disappeared after readiness check`,
          );
        }
        return lastStatus;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 750);
    });
  }
  throw new Error(
    `whatsapp account "${accountId}" did not become ready` +
      (lastStatus ? `; last status: ${JSON.stringify(lastStatus)}` : ""),
  );
}

export async function waitForWhatsAppChannelStable(gateway: WhatsAppQaGateway, accountId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WHATSAPP_QA_READY_TIMEOUT_MS) {
    const status = await waitForWhatsAppChannelRunning(gateway, accountId);
    const connectedAt =
      typeof status.lastConnectedAt === "number" && status.lastConnectedAt > 0
        ? status.lastConnectedAt
        : Date.now();
    const connectedForMs = Date.now() - connectedAt;
    if (connectedForMs >= WHATSAPP_QA_READY_STABILITY_MS) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(750, WHATSAPP_QA_READY_STABILITY_MS - connectedForMs));
    });
  }
  throw new Error(
    `whatsapp account "${accountId}" did not remain ready for ${WHATSAPP_QA_READY_STABILITY_MS}ms`,
  );
}

async function listTarEntries(archivePath: string): Promise<string[]> {
  const { stdout } = await runExec("tar", ["-tzf", archivePath], {
    logOutput: false,
    timeoutMs: WHATSAPP_QA_AUTH_ARCHIVE_TIMEOUT_MS,
  });
  return normalizeStringEntries(stdout.split("\n"));
}

function assertSafeArchiveEntries(entries: string[]) {
  if (entries.length === 0) {
    throw new Error("WhatsApp auth archive is empty.");
  }
  for (const entry of entries) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/u).includes("..")) {
      throw new Error(`WhatsApp auth archive contains unsafe entry "${entry}".`);
    }
  }
}

export async function unpackWhatsAppAuthArchive(params: {
  archiveBase64: string;
  clearSignalSessions?: boolean;
  label: string;
  parentDir: string;
}): Promise<string> {
  const authDir = path.join(params.parentDir, params.label);
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(params.parentDir, `${params.label}.tgz`);
  await fs.writeFile(archivePath, Buffer.from(params.archiveBase64, "base64"), { mode: 0o600 });
  const entries = await listTarEntries(archivePath);
  assertSafeArchiveEntries(entries);
  await runExec("tar", ["-xzf", archivePath, "-C", authDir], {
    logOutput: false,
    timeoutMs: WHATSAPP_QA_AUTH_ARCHIVE_TIMEOUT_MS,
  });
  await fs.rm(archivePath, { force: true });
  if (params.clearSignalSessions === true) {
    await clearWhatsAppAuthSignalSessions(authDir);
  }
  return authDir;
}

async function clearWhatsAppAuthSignalSessions(authDir: string): Promise<string[]> {
  const removed: string[] = [];
  const entries = await fs.readdir(authDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !WHATSAPP_QA_SIGNAL_SESSION_FILE_RE.test(entry.name)) {
      continue;
    }
    await fs.rm(path.join(authDir, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed.toSorted();
}
