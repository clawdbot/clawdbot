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
    const version = Number(database.prepare("PRAGMA user_version").get().user_version);
    assert.equal(
      version,
      Number(args[0]),
      "shared schema changed outside its supported transition",
    );
    result = { version };
  } finally {
    database.close();
  }
} else if (command === "refusal") {
  assert.equal(Number(args[0]), 1, "old updater must fail with its ordinary failure exit");
  const stdout = fs.readFileSync(args[1], "utf8");
  const stderr = fs.readFileSync(args[2], "utf8");
  const update = JSON.parse(stdout);
  assert.equal(update.status, "error");
  assert.equal(update.reason, "openclaw doctor");
  assert.match(
    stdout + stderr,
    /Updater-owned Doctor cannot migrate shared state from schema 15 to 16 while the older updater owns completion\./,
  );
  result = { status: "safely-refused", method: "in-process-self-update", exitCode: 1 };
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
  const guarded =
    ["2026.8.2", "2026.9.2"].includes(baselineVersion) && candidateVersion === "2026.9.3";
  const read = (name) => JSON.parse(fs.readFileSync(path.join(evidenceDir, name), "utf8"));
  result = {
    method: "external-package-manager-and-fresh-doctor",
    baselineVersion,
    candidateVersion,
    selfUpdatePassed: false,
    ...(guarded
      ? {
          selfUpdate: read("self-update-refusal.json"),
          schemaBefore: read("schema-before.json"),
          schemaAfterRefusal: read("schema-after-refusal.json"),
          schemaAfterDoctor: read("schema-after-doctor.json"),
        }
      : {}),
  };
} else {
  throw new Error(`unknown transition assertion ${command}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
