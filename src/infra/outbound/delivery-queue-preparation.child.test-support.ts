import { withStableDeliveryPreparation } from "./delivery-queue-preparation.js";

const [stateDir, id] = process.argv.slice(2);
if (!stateDir || !id) {
  throw new Error("usage: <stateDir> <id>");
}

await withStableDeliveryPreparation({
  id,
  stateDir,
  run: async (owner) => {
    owner.beforeFirstModifier();
    process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
    await new Promise<void>(() => {
      setInterval(() => {}, 1_000);
    });
  },
});
