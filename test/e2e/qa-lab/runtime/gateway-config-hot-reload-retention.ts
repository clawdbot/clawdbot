import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { hasErrnoCode } from "../../../../src/infra/errno.js";

const MINUTE_MS = 60_000;

export async function startHotReloadAttachmentRetention({
  gateway,
  patch,
  verifyContinuity,
  appendLog,
}: {
  gateway: QaGatewayChild;
  patch: (change: unknown) => Promise<unknown>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
  appendLog: (text: string) => void;
}): Promise<{ completion: Promise<void>; stop: () => Promise<void> }> {
  const log = (text: string) => {
    appendLog(text);
    process.stdout.write(text);
  };
  assert.equal(gateway.cfg.attachments?.ttlHours, 24, "Retention proof requires startup TTL 24h");
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  assert(stateDir && path.isAbsolute(stateDir), "Gateway must have an isolated absolute state dir");
  const mediaDir = path.join(stateDir, "media");
  await fs.mkdir(mediaDir, { recursive: true });
  const directory = await fs.mkdtemp(path.join(mediaDir, "qa-hot-reload-retention-"));
  const expired = path.join(directory, "expired.txt");
  const fresh = path.join(directory, "fresh.txt");
  const marker = "Synthetic hot-reload retention proof\n";
  try {
    await fs.writeFile(expired, marker);
    await fs.writeFile(fresh, marker);
    const oldTime = new Date(Date.now() - 3 * 60 * MINUTE_MS);
    await fs.utimes(expired, oldTime, oldTime);
    assert.equal(await fs.readFile(expired, "utf8"), marker);
    assert.equal(await fs.readFile(fresh, "utf8"), marker);
    log("START attachments.ttlHours: startup TTL 24h; synthetic files aged 3h and fresh\n");
    await patch({ attachments: { ttlHours: 2 } });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }

  const controller = new AbortController();
  const { signal } = controller;
  const started = Date.now();
  const deadline = started + 70 * MINUTE_MS;
  const completion = (async () => {
    log(
      "WAIT attachments.ttlHours: TTL 2h committed; awaiting real initial or hourly maintenance\n",
    );
    let nextProgress = started + 5 * MINUTE_MS;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const exists = await fs.stat(expired).then(
        () => true,
        (error: unknown) => {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          return false;
        },
      );
      assert.equal(await fs.readFile(fresh, "utf8"), marker, "The fresh attachment must survive");
      signal.throwIfAborted();
      const elapsedMinutes = ((Date.now() - started) / MINUTE_MS).toFixed(1);
      if (!exists) {
        await verifyContinuity(
          "attachments.ttlHours",
          `TTL 24h→2h; real maintenance removed the 3h-old file after ${elapsedMinutes}min while preserving the fresh file (initial or hourly sweep)`,
        );
        log(
          `DONE attachments.ttlHours: expired removed, fresh retained after ${elapsedMinutes}min\n`,
        );
        return;
      }
      if (Date.now() >= nextProgress) {
        log(`WAIT attachments.ttlHours: ${elapsedMinutes}min; both files still present\n`);
        nextProgress = Date.now() + 5 * MINUTE_MS;
      }
      await delay(Math.min(30_000, deadline - Date.now()), undefined, { signal });
    }
    throw new Error("attachments.ttlHours: the 3h-old file survived 70min after TTL 24h→2h");
  })();
  return {
    completion,
    async stop() {
      controller.abort(new Error("Attachment retention proof stopped"));
      // The caller owns the proof verdict; cleanup joins it without replacing its failure.
      await Promise.allSettled([completion]);
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
