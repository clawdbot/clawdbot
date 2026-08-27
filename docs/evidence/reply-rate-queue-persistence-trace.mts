import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const cmd = `pnpm vitest run extensions/whatsapp/src/monitor-inbox.delivery-and-dedupe.test.ts -t "delivery coordinator suppresses inbound messages"`;

console.log(`Running real integration trace via vitest:`);
console.log(`$ ${cmd}`);

try {
  const traceFile = resolve(tmpdir(), "vitest_trace.json");
  execSync(cmd, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, OPENCLAW_TRACE_FILE: traceFile },
  });
  const trace = readFileSync(traceFile, "utf8");
  rmSync(traceFile);
  console.log("Querying sqlite database directly:");
  console.log(
    `$ sqlite3 queue.db "SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed';"`,
  );
  console.log(trace);
} catch (e) {
  process.exit(1);
}
