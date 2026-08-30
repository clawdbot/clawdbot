import { execSync, execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const cmd = `pnpm vitest run extensions/whatsapp/src/monitor-inbox.delivery-and-dedupe.test.ts -t "delivery coordinator suppresses inbound messages"`;

console.log(`Running real integration trace via vitest:`);
console.log(`$ ${cmd}`);

try {
  execSync(cmd, { cwd: root, stdio: "ignore" });

  // Find the latest openclaw-whatsapp-ingress directory in /tmp
  const tmp = "/tmp";
  const dirs = readdirSync(tmp)
    .filter((name) => name.startsWith("openclaw-whatsapp-ingress-"))
    .map((name) => ({
      name,
      path: resolve(tmp, name),
      mtime: statSync(resolve(tmp, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (dirs.length === 0) {
    throw new Error("Could not find openclaw-whatsapp-ingress state directory");
  }

  const stateDir = dirs[0].path;
  const dbPath = resolve(stateDir, "state", "openclaw.sqlite");

  console.log("Querying sqlite database directly:");
  console.log(
    `$ sqlite3 "${dbPath}" -json "SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed';"`,
  );

  const result = execFileSync(
    "sqlite3",
    [
      dbPath,
      "-json",
      "SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed';",
    ],
    { cwd: root, encoding: "utf8" },
  );
  console.log(result);
} catch (e) {
  console.error("Trace failed", e);
  process.exit(1);
}
