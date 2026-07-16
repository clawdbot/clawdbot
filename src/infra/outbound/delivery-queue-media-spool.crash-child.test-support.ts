// Child process for the delivery-queue media crash boundary test. Stages media
// and commits a durable row exactly as the outbound enqueue seam does, then
// parks so the parent can kill it before any platform dispatch happens.
import { stageQueuePayloadMedia } from "./delivery-queue-media-spool.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";

async function main(): Promise<void> {
  const [stateDir, sourceDir, source] = process.argv.slice(2);
  if (!stateDir || !sourceDir || !source) {
    throw new Error("usage: <stateDir> <sourceDir> <source>");
  }
  const staged = await stageQueuePayloadMedia({
    payloads: [{ text: "voice note", mediaUrl: source, audioAsVoice: true }],
    mediaAccess: { localRoots: [sourceDir] },
    maxBytes: 5 * 1024 * 1024,
    stateDir,
  });
  if (staged.status !== "staged") {
    throw new Error(`staging refused: ${staged.reason}`);
  }
  const id = await enqueueDelivery(
    {
      channel: "matrix",
      to: "!room:example",
      queuePolicy: "best_effort",
      payloads: staged.payloads,
    },
    stateDir,
    staged.mediaStageId,
  );
  process.stdout.write(
    `${JSON.stringify({ id, pid: process.pid, artifacts: staged.artifacts })}\n`,
  );
  // Row is committed and no send has been attempted: park here so the parent
  // kills this process at exactly the crash boundary under test.
  setInterval(() => {}, 1_000);
}

await main();
