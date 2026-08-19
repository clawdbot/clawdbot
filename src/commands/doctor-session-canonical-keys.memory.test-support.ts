import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";

async function main(): Promise<void> {
  const [stateDir, storeTemplate] = process.argv.slice(2);
  if (!stateDir || !storeTemplate) {
    throw new Error("usage: <state-dir> <store-template>");
  }
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const result = await repairCanonicalSessionKeys({
    apply: false,
    cfg: {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storeTemplate },
    },
    env,
  });
  process.stdout.write(JSON.stringify(result));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
