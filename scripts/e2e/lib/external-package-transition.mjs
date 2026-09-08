import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [command, ...args] = process.argv.slice(2);
let result;
if (command === "schema") {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert(stateDir, "explicit isolated state directory required");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const publishedVersion = Number(database.prepare("PRAGMA user_version").get().user_version);
    const hasMetadata = database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'config_machine_state'")
      .get();
    const row = hasMetadata
      ? database
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
          )
          .get()
      : undefined;
    const appliedVersion = row ? JSON.parse(row.value_json) : publishedVersion;
    assert(
      Number.isSafeInteger(appliedVersion) && appliedVersion >= 0,
      "invalid schema content version",
    );
    const contentVersion = Math.max(publishedVersion, appliedVersion);
    assert.equal(
      contentVersion,
      Number(args[0]),
      "shared schema changed outside its supported transition",
    );
    result = { publishedVersion, contentVersion };
  } finally {
    database.close();
  }
} else if (command === "session-key") {
  const listing = JSON.parse(fs.readFileSync(args[0], "utf8"));
  const matches = listing.sessions.filter((session) => session.sessionId === args[1]);
  assert.equal(matches.length, 1, "expected one retained session identity");
  assert.equal(typeof matches[0].key, "string");
  process.stdout.write(matches[0].key);
  process.exit(0);
} else if (command === "history") {
  const history = JSON.parse(fs.readFileSync(args[0], "utf8"));
  const text = (message) =>
    typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((part) => part.text ?? "").join("\n");
  for (const role of ["user", "assistant"]) {
    assert(
      history.messages.some((message) => message.role === role && text(message).includes(args[1])),
      `durable ${role} message did not retain its marker`,
    );
  }
  result = { persistedUserAndAssistant: true };
} else if (command === "receipt") {
  const [baselineVersion, candidateVersion, evidenceDir] = args;
  const historicalStateSchema =
    ["2026.8.2", "2026.9.2"].includes(baselineVersion) && candidateVersion === "2026.9.3";
  const read = (name) => JSON.parse(fs.readFileSync(path.join(evidenceDir, name), "utf8"));
  result = {
    method: "external-package-manager-and-fresh-doctor",
    baselineVersion,
    candidateVersion,
    selfUpdatePassed: false,
    selfUpdate: { status: "not-run", method: "in-process-self-update" },
    ...(historicalStateSchema
      ? {
          schemaBefore: read("schema-before.json"),
          schemaAfterDoctor: read("schema-after-doctor.json"),
        }
      : {}),
  };
} else {
  throw new Error(`unknown transition assertion ${command}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
