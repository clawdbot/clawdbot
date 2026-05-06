import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import type { DeliverFn, RecoveryLogger } from "./delivery-queue.js";

export function installDeliveryQueueTmpDirHooks(): { readonly tmpDir: () => string } {
  let tmpDir = "";
  let fixtureRoot = "";
  let fixtureCount = 0;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-suite-"));
  });

  beforeEach(() => {
    tmpDir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    if (!fixtureRoot) {
      return;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  });

  return {
    tmpDir: () => tmpDir,
  };
}

export function readQueuedEntry(tmpDir: string, id: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDir, "delivery-queue", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;
}

export function setQueuedEntryState(
  tmpDir: string,
  id: string,
  state: {
    retryCount: number;
    lastAttemptAt?: number;
    enqueuedAt?: number;
    platformSendStartedAt?: number;
    recoveryState?: "send_attempt_started" | "unknown_after_send";
  },
): void {
  const filePath = path.join(tmpDir, "delivery-queue", `${id}.json`);
  const entry = readQueuedEntry(tmpDir, id);
  entry.retryCount = state.retryCount;
  if (state.lastAttemptAt === undefined) {
    delete entry.lastAttemptAt;
  } else {
    entry.lastAttemptAt = state.lastAttemptAt;
  }
  if (state.enqueuedAt !== undefined) {
    entry.enqueuedAt = state.enqueuedAt;
  }
  if (state.platformSendStartedAt !== undefined) {
    entry.platformSendStartedAt = state.platformSendStartedAt;
  }
  if (state.recoveryState !== undefined) {
    entry.recoveryState = state.recoveryState;
  }
  fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8");
}

export function createRecoveryLog(): RecoveryLogger & {
  info: ReturnType<typeof vi.fn<(msg: string) => void>>;
  warn: ReturnType<typeof vi.fn<(msg: string) => void>>;
  error: ReturnType<typeof vi.fn<(msg: string) => void>>;
} {
  return {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  };
}

export function asDeliverFn(deliver: ReturnType<typeof vi.fn>): DeliverFn {
  return deliver as DeliverFn;
}
