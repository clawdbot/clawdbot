import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { noteSessionTranscriptHeaderHealth } from "./doctor-session-transcript-headers.js";
import { noteSessionTranscriptLabelHealth } from "./doctor-session-transcript-labels.js";

const [stateDir, scenario, sqlitePath, expectedDigest] = process.argv.slice(2);
assert(
  stateDir && sqlitePath && expectedDigest && (scenario === "headers" || scenario === "labels"),
);
process.stderr.write(`checking ${scenario}\n`);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
const started = performance.now();
const params = {
  cfg: { agents: { list: [{ id: "main" }] } },
  env: process.env,
  shouldRepair: true,
};
if (scenario === "headers") {
  assert.deepEqual(await noteSessionTranscriptHeaderHealth(params), { found: 0, repaired: 0 });
} else {
  await noteSessionTranscriptLabelHealth(params);
}
const after = createHash("sha256");
const database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
try {
  for (const row of database
    .prepare("SELECT seq, created_at, event_json FROM transcript_events ORDER BY session_id, seq")
    .iterate()) {
    after.update(JSON.stringify(row));
  }
} finally {
  database.close();
}
assert.equal(after.digest("hex"), expectedDigest);
process.stdout.write(
  JSON.stringify({
    scenario,
    eventCount: 4096,
    elapsedMs: performance.now() - started,
    maxRssKiB: process.resourceUsage().maxRSS,
  }),
);
