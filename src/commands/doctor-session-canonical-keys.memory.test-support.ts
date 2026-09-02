import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";

export const canonicalMemoryTestSupportModuleUrl = import.meta.url;

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
  // The 160 MiB proof covers repair and result serialization, not unrelated Node shutdown tasks.
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

// Node resolves the bundle through shared node_modules; compare canonical paths.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
