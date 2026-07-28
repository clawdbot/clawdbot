import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

export type IngressDrainTestPayload = { text: string };

export function createTestIngressQueue(
  stateDir: string,
  options: Omit<
    Parameters<typeof createChannelIngressQueue>[0],
    "channelId" | "accountId" | "stateDir"
  > = {},
) {
  return createChannelIngressQueue<IngressDrainTestPayload>({
    channelId: "test",
    accountId: "a",
    stateDir,
    ...options,
  });
}

export async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-drain-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
