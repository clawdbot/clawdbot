import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Match #141109's shared-state reader without importing stores that can migrate.
function readContentVersion(database, kind, published) {
  if (
    kind !== "state" ||
    !database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'")
      .get()
  ) {
    return published;
  }
  const row = database
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    .get("state.schema.contentVersion");
  if (!row) {
    return published;
  }
  const contentVersion = JSON.parse(row.value_json);
  assert(
    Number.isSafeInteger(contentVersion) && contentVersion >= 0,
    "invalid shared state schema content version",
  );
  return Math.max(published, contentVersion);
}

function readSchemas(stateDir) {
  const paths = [{ kind: "state", relative: "state/openclaw.sqlite" }];
  const agentsDir = path.join(stateDir, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const agent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (agent.isDirectory()) {
        const relative = `agents/${agent.name}/agent/openclaw-agent.sqlite`;
        if (fs.existsSync(path.join(stateDir, relative))) {
          paths.push({ kind: "agent", relative });
        }
      }
    }
  }
  return paths
    .toSorted((a, b) => a.relative.localeCompare(b.relative))
    .map((entry) => {
      const databasePath = path.join(stateDir, entry.relative);
      if (!fs.existsSync(databasePath)) {
        return {
          kind: entry.kind,
          relative: entry.relative,
          userVersion: null,
          contentVersion: null,
        };
      }
      // Never import a runtime store: the observer must not perform a migration.
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const userVersion = database.prepare("PRAGMA user_version").get().user_version;
        return {
          kind: entry.kind,
          relative: entry.relative,
          userVersion,
          contentVersion: readContentVersion(database, entry.kind, userVersion),
        };
      } finally {
        database.close();
      }
    });
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sessionIdentities(index) {
  return Object.entries(index)
    .map(([sessionKey, entry]) => {
      assert(typeof entry.sessionId === "string", `legacy session id missing: ${sessionKey}`);
      return { sessionKey, sessionId: entry.sessionId };
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}

function transcriptIdentity(event) {
  // Doctor repairs metadata; the fixture's text-only turn must retain event IDs and messages.
  return {
    type: event.type,
    id: event.id,
    ...(event.type === "message"
      ? {
          role: event.message.role,
          textHash: hashBytes(
            JSON.stringify(
              typeof event.message.content === "string"
                ? [event.message.content]
                : event.message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text),
            ),
          ),
        }
      : {}),
  };
}

function readSeededAgents(stateDir, configFile) {
  const config = readJson(configFile);
  const entries =
    config.agents?.entries ??
    Object.fromEntries((config.agents?.list ?? []).map((entry) => [entry.id, entry]));
  const agentIds = Object.keys(entries).toSorted();
  assert.deepEqual(agentIds, ["main", "ops"], "legacy operator seeded agent roster changed");
  return agentIds.map((agentId) => {
    const agentRoot = path.join(stateDir, "agents", agentId);
    if (entries[agentId].agentDir) {
      assert.equal(path.resolve(entries[agentId].agentDir), path.join(agentRoot, "agent"));
    }
    const files = [];
    function visitSessions(directory) {
      if (!fs.existsSync(directory)) {
        return;
      }
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visitSessions(absolute);
          continue;
        }
        assert(entry.isFile(), `non-file baseline agent specimen: ${absolute}`);
        const local = path.relative(agentRoot, absolute).split(path.sep).join("/");
        const relative = path.relative(stateDir, absolute).split(path.sep).join("/");
        const bytes = fs.readFileSync(absolute);
        const specimen = { relative, sha256: hashBytes(bytes) };
        if (local === "sessions/sessions.json") {
          files.push({
            ...specimen,
            kind: "legacy-store",
            sessions: sessionIdentities(JSON.parse(bytes.toString("utf8"))),
          });
        } else if (/^sessions\/[^/]+\.trajectory(?:\.jsonl|-path\.json)$/u.test(local)) {
          files.push({ ...specimen, kind: "trajectory" });
        } else if (/^sessions\/[^/]+\.jsonl$/u.test(local)) {
          const events = bytes
            .toString("utf8")
            .split(/\r?\n/u)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line));
          const sessionId = events.find((event) => event.type === "session")?.id;
          assert(typeof sessionId === "string", `legacy transcript header missing: ${relative}`);
          files.push({
            ...specimen,
            kind: "transcript",
            sessionId,
            events: events.map(transcriptIdentity),
          });
        } else if (
          /^sessions\/skills-prompts\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.txt$/u.test(local)
        ) {
          // skill-prompt-blobs.ts retains content-addressed source artifacts during Doctor import.
          files.push({ ...specimen, kind: "skill-prompt" });
        } else {
          throw new Error(`unclassified baseline agent specimen: ${relative}`);
        }
      }
    }
    visitSessions(path.join(agentRoot, "sessions"));
    // Model catalogs and other per-agent artifacts have separate owners.
    const runtimeDir = path.join(agentRoot, "agent");
    if (fs.existsSync(runtimeDir)) {
      for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
        // WAL, shared memory, and reindex scratch belong to the existing SQLite owner.
        if (!entry.name.startsWith("openclaw-agent.sqlite")) {
          continue;
        }
        assert(entry.isFile(), `non-file baseline SQLite specimen: ${entry.name}`);
        files.push({ relative: `agents/${agentId}/agent/${entry.name}`, kind: "sqlite-runtime" });
      }
    }
    const databaseRelative = `agents/${agentId}/agent/openclaw-agent.sqlite`;
    return {
      agentId,
      databaseRelative,
      requiresDatabase:
        fs.existsSync(path.join(stateDir, databaseRelative)) ||
        files.some((file) => file.sessions?.length > 0 || file.events?.length > 0),
      files: files.toSorted((a, b) => a.relative.localeCompare(b.relative)),
    };
  });
}

function assertSeededAgents(snapshot) {
  const manifestDir = path.join(snapshot.stateDir, "session-sqlite-migration-runs");
  const targets = fs.existsSync(manifestDir)
    ? fs
        .readdirSync(manifestDir)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => {
          const manifest = readJson(path.join(manifestDir, name));
          return manifest.completedAt && !manifest.failedAt ? manifest.targets : [];
        })
    : [];
  for (const agent of snapshot.agents) {
    const databasePath = path.join(snapshot.stateDir, agent.databaseRelative);
    assert(
      !agent.requiresDatabase || fs.existsSync(databasePath),
      `required agent database missing before candidate probes: ${agent.agentId}`,
    );
    const database = agent.requiresDatabase
      ? new DatabaseSync(databasePath, { readOnly: true })
      : null;
    try {
      if (database) {
        assert.equal(
          database.prepare("PRAGMA user_version").get().user_version,
          snapshot.candidateSchemaVersions.agent,
          `required agent database lacks candidate schema: ${agent.agentId}`,
        );
      }
      for (const file of agent.files) {
        if (file.kind === "sqlite-runtime") {
          continue;
        }
        const source = path.join(snapshot.stateDir, file.relative);
        if (file.kind === "skill-prompt") {
          assert(fs.existsSync(source), `legacy skill prompt missing: ${file.relative}`);
          assert.equal(
            hashBytes(fs.readFileSync(source)),
            file.sha256,
            `legacy skill prompt changed: ${file.relative}`,
          );
          continue;
        }
        // doctor-session-sqlite.ts moves verified originals; recovery manifests own their destinations.
        assert(!fs.existsSync(source), `legacy agent specimen was not retired: ${file.relative}`);
        const move = targets
          .filter(
            (target) =>
              target.agentId === agent.agentId &&
              target.sqlitePath === databasePath &&
              target.validationBeforeArchive === "passed",
          )
          .flatMap((target) => target.completedMoves)
          .find((item) => item.sourcePath === source && item.kind === file.kind);
        assert(move, `legacy agent specimen lacks completed archive receipt: ${file.relative}`);
        const archiveRoot = path.join(
          snapshot.stateDir,
          "agents",
          agent.agentId,
          "session-sqlite-import-archive",
        );
        assert.equal(
          path.dirname(move.archivePath),
          archiveRoot,
          "agent archive escaped its owner",
        );
        assert(fs.existsSync(move.archivePath), `legacy agent archive missing: ${file.relative}`);
        if (file.kind === "legacy-store") {
          // Earlier Doctor passes may normalize the entry, but keys and session identities must survive.
          assert.deepEqual(
            sessionIdentities(readJson(move.archivePath)),
            file.sessions,
            `legacy session index identities changed: ${file.relative}`,
          );
          for (const session of file.sessions) {
            const row = database
              .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
              .get(session.sessionKey);
            assert.equal(
              row?.current_session_id,
              session.sessionId,
              `legacy session was not imported: ${session.sessionKey}`,
            );
          }
        } else {
          assert.equal(
            hashBytes(fs.readFileSync(move.archivePath)),
            file.sha256,
            `legacy agent archive changed: ${file.relative}`,
          );
          if (file.kind === "transcript") {
            const events = database
              .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
              .all(file.sessionId)
              .map((row) => transcriptIdentity(JSON.parse(row.event_json)));
            for (const expected of file.events) {
              assert.deepEqual(
                events.find((event) => event.id === expected.id && event.type === expected.type),
                expected,
                `legacy transcript event was not imported: ${file.relative} (${expected.id})`,
              );
            }
          }
        }
      }
    } finally {
      database?.close();
    }
    console.error(
      `Agent migration verified before candidate probes: ${agent.agentId} (${agent.requiresDatabase ? "candidate store required" : "no legacy state; store may remain lazy"}).`,
    );
  }
}

function prepare(baselineVersion, candidateTarball, stateDir, snapshotFile, configFile) {
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", candidateTarball.replace(/^file:/u, ""), "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
  assert.equal(manifest.name, "openclaw", "candidate is not an OpenClaw package");
  for (const kind of ["state", "agent"]) {
    assert(
      Number.isInteger(manifest.openclaw?.schemaVersions?.[kind]) &&
        manifest.openclaw.schemaVersions[kind] >= 0,
      `candidate package is missing its ${kind} schema version`,
    );
  }
  const snapshot = {
    baselineVersion,
    candidateVersion: manifest.version,
    candidateSchemaVersions: manifest.openclaw.schemaVersions,
    stateDir,
    databases: readSchemas(stateDir),
    agents: readSeededAgents(stateDir, configFile),
  };
  fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  return "success";
}

function assertOutcome(snapshotFile, exitCode, installedVersion, acceptedOutcome, afterFile) {
  const snapshot = readJson(snapshotFile);
  // The updater result classifier owns post-core warnings; they can exit 1
  // after installing the candidate and completing its schema migrations.
  assert(
    acceptedOutcome === "success" || acceptedOutcome === "recoverable",
    "update outcome was not accepted by the updater result checks",
  );
  assert(
    Number(exitCode) === 0 || (acceptedOutcome === "recoverable" && Number(exitCode) === 1),
    "baseline requires a successful or validated recoverable update",
  );
  assert.equal(installedVersion, snapshot.candidateVersion, "candidate package is not installed");
  const databases = readSchemas(snapshot.stateDir);
  fs.writeFileSync(afterFile, `${JSON.stringify({ ...snapshot, databases }, null, 2)}\n`);
  assertSeededAgents(snapshot);
  const currentPaths = new Set(databases.map((database) => database.relative));
  for (const database of snapshot.databases) {
    if (database.userVersion !== null) {
      assert(
        currentPaths.has(database.relative),
        `baseline database missing after update: ${database.relative}`,
      );
    }
  }
  for (const database of databases) {
    assert.equal(
      database.contentVersion,
      snapshot.candidateSchemaVersions[database.kind],
      `${database.relative} does not have the candidate schema`,
    );
  }
  return "success";
}

try {
  const [command, ...args] = process.argv.slice(2);
  assert(
    (command === "prepare" && args.length === 5) || (command === "assert" && args.length === 5),
    "usage: schema-expectation.mjs prepare <baseline-version> <candidate.tgz> <state-dir> <snapshot.json> <config.json> | assert <snapshot.json> <exit-code> <installed-version> <accepted-outcome> <after.json>",
  );
  process.stdout.write(`${command === "prepare" ? prepare(...args) : assertOutcome(...args)}\n`);
} catch (error) {
  process.stderr.write(`Schema expectation failed: ${error.message}\n`);
  process.exitCode = 1;
}
