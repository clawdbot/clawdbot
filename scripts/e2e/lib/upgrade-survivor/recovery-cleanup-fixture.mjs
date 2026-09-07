import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function writeRecoveryJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readRecoveryJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function recoveryFileIdentity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert(stat.isFile(), `expected regular recovery file: ${file}`);
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) {
        break;
      }
      digest.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    sha256: digest.digest("hex"),
  };
}

export function recoveryVolumeSpec(env = process.env) {
  const positive = (name, fallback) => {
    const raw = env[name]?.trim() || String(fallback);
    assert(/^[1-9][0-9]*$/u.test(raw), `${name} must be a positive integer`);
    const value = Number(raw);
    assert(Number.isSafeInteger(value), `${name} must be a safe integer`);
    return value;
  };
  return {
    sessions: positive("OPENCLAW_UPGRADE_SURVIVOR_VOLUME_SESSIONS", 2),
    eventsPerSession: positive("OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION", 8),
  };
}

export function recoveryEvent(sessionId, sequence, large = false) {
  if (sequence === 0) {
    return { type: "session", version: 3, id: sessionId, timestamp: "2026-07-01T10:00:00.000Z" };
  }
  return {
    type: "message",
    id: `${sessionId}-${sequence}`,
    parentId: sequence === 1 ? null : `${sessionId}-${sequence - 1}`,
    timestamp: new Date(Date.parse("2026-07-01T10:00:00.000Z") + sequence * 1000).toISOString(),
    message: {
      role: sequence % 2 ? "user" : "assistant",
      content: [
        { type: "text", text: `${sessionId}:${sequence}:λ${large ? "x".repeat(4096) : ""}` },
      ],
    },
  };
}

// One event at a time: increasing volume must exercise the importer, not the seeder's heap.
export function writeRecoveryTranscript(file, sessionId, count, large = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    for (let sequence = 0; sequence < count; sequence += 1) {
      fs.writeSync(fd, `${JSON.stringify(recoveryEvent(sessionId, sequence, large))}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function seedRecoveryFixture(stateDir, spec) {
  const originals = [];
  const histories = [];
  const stores = new Map();
  const record = (source, disposition, reported = true) => {
    originals.push({ source, disposition, reported, identity: recoveryFileIdentity(source) });
  };
  const add = (agentId, sessionId, count, disposition = "candidate", large = false) => {
    const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
    const sessionKey = `agent:${agentId}:${sessionId}`;
    const source = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
    writeRecoveryTranscript(source, sessionId, count, large);
    const store = stores.get(storePath) ?? {};
    store[sessionKey] = { sessionId, sessionFile: source, updatedAt: Date.now(), label: sessionId };
    stores.set(storePath, store);
    return { agentId, sessionId, sessionKey, source, count, disposition, large };
  };
  const old = add("recovery-clean", "recovery-old", 4);
  histories.push(old);
  record(old.source, old.disposition);
  const branch = add("recovery-clean", "recovery-branch", 1);
  const retired = recoveryEvent(branch.sessionId, 1);
  retired.id = "retired-branch";
  retired.message.content[0].text +=
    "\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nretired context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
  const user = recoveryEvent(branch.sessionId, 1);
  const reply = recoveryEvent(branch.sessionId, 2);
  reply.message.provider = "openai-codex";
  reply.message.api = "openai-codex-responses";
  fs.appendFileSync(
    branch.source,
    [retired, user, reply].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  histories.push({ ...branch, count: 3 });
  record(branch.source, "candidate");
  for (let index = 0; index < spec.sessions; index += 1) {
    const fixture = add(
      "recovery-clean",
      `recovery-scale-${index}`,
      spec.eventsPerSession,
      "candidate",
      true,
    );
    record(fixture.source, "candidate");
    // Bounded public tail probes, even when the fixture has millions of events.
    if (index === 0 || index === spec.sessions - 1) {
      histories.push(fixture);
    }
  }
  const malformed = add("recovery-protected", "recovery-malformed", 2, "protected");
  fs.appendFileSync(
    malformed.source,
    '{broken-prefix\n{"type":"message","id":"unique-unimported","message":{"role":"user","content":"must survive"}}\n',
  );
  record(malformed.source, "protected");
  const dependent = add("recovery-protected", "recovery-dependent", 3, "protected");
  record(dependent.source, "protected");
  const protectedDir = path.dirname(malformed.source);
  // Incomplete index coverage leaves unknown sources in place; complete stores still archive
  // their unindexed history as protected. Prove both without requiring an unsafe sweep.
  for (const { source, contents, disposition, reported } of [
    {
      source: path.join(protectedDir, "recovery-malformed.trajectory.jsonl"),
      contents: '{"type":"trajectory","trace":"synthetic"}\n',
      disposition: "protected",
      reported: true,
    },
    {
      source: path.join(protectedDir, "recovery-unreferenced.jsonl"),
      contents: '{"type":"message","message":{"role":"user","content":"unindexed history"}}\n',
      disposition: "unmanifested",
      reported: false,
    },
    {
      source: path.join(path.dirname(old.source), "recovery-unreferenced.jsonl"),
      contents:
        '{"type":"message","message":{"role":"user","content":"unindexed complete-store history"}}\n',
      disposition: "protected",
      reported: true,
    },
  ]) {
    fs.writeFileSync(source, contents);
    record(source, disposition, reported);
  }
  for (const [storePath, store] of stores) {
    const protectedStore = storePath.includes("recovery-protected");
    if (protectedStore) {
      store["invalid-index-entry"] = 42;
    }
    writeRecoveryJson(storePath, store);
    record(storePath, protectedStore ? "protected" : "candidate");
  }
  for (const relative of [
    "backups/operator-backup.bak",
    "agents/recovery-clean/session-sqlite-import-archive/unknown-original.jsonl",
    "agents/recovery-clean/sessions/unknown.jsonl.pre-doctor-20260701",
  ]) {
    const source = path.join(stateDir, relative);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, `independent synthetic sentinel: ${relative}\n`);
    record(source, "unmanifested", !relative.startsWith("backups/"));
  }
  return { spec, originals, histories };
}

export function readRecoveryMoves(stateDir) {
  const directory = path.join(stateDir, "session-sqlite-migration-runs");
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".failure.json"))
    .flatMap((name) => {
      const manifestPath = path.join(directory, name);
      const manifest = readRecoveryJson(manifestPath);
      return manifest.targets.flatMap((target) =>
        target.completedMoves.map((move) => ({
          ...move,
          manifestPath,
          runId: manifest.runId,
          manifestVersion: manifest.manifestVersion,
          completedAt: manifest.completedAt,
          failedAt: manifest.failedAt,
          sqlitePath: target.sqlitePath,
        })),
      );
    });
}

export function assertRecoveryOriginals(fixture, moves) {
  return fixture.originals.map((original) => {
    if (original.disposition === "unmanifested") {
      assert(
        !moves.some((move) => move.sourcePath === original.source),
        `unexpectedly recorded source: ${original.source}`,
      );
      assert.deepEqual(
        recoveryFileIdentity(original.source),
        original.identity,
        `sentinel changed: ${original.source}`,
      );
      return { ...original, archive: original.source };
    }
    const matches = moves.filter(
      (move) => move.sourcePath === original.source && move.artifact?.disposal.state === "retained",
    );
    assert(matches.length > 0, `updater did not record original: ${original.source}`);
    const archives = [...new Set(matches.map((move) => move.archivePath))];
    assert.equal(archives.length, 1, `multiple retained copies of ${original.source}`);
    assert(!fs.existsSync(original.source), `legacy source still active: ${original.source}`);
    const archive = archives[0];
    assert.deepEqual(
      recoveryFileIdentity(archive),
      original.identity,
      `original copied or rewritten: ${original.source}`,
    );
    for (const move of matches) {
      assert.equal(move.manifestVersion, 3, "updater omitted recovery evidence");
      assert(move.completedAt && !move.failedAt, `migration did not finish: ${move.runId}`);
      assert.deepEqual(
        move.artifact.identity,
        original.identity,
        `manifest fingerprint changed: ${archive}`,
      );
      if (original.disposition === "candidate") {
        assert(
          ["imported", "repair-original"].includes(move.artifact.classification),
          `clean original not verified: ${archive}`,
        );
      }
    }
    return { ...original, archive };
  });
}

export function assertRecoveryInventory(report, originals) {
  assert.equal(report.status, "preview");
  assert.equal(report.dryRun, true);
  assert(Array.isArray(report.artifacts), "cleanup omitted inventory");
  for (const original of originals) {
    if (original.reported === false) {
      continue;
    }
    const item = report.artifacts.find((entry) => entry.path === original.archive);
    assert(item, `cleanup omitted ${original.archive}`);
    assert.equal(
      item.outcome,
      original.disposition === "unmanifested" ? "protected" : original.disposition,
      `wrong cleanup classification: ${original.archive} (${item.reason})`,
    );
    assert.equal(item.bytes, original.identity.size, `wrong cleanup size: ${original.archive}`);
    assert(
      item.reason && Array.isArray(item.runs),
      `cleanup omitted provenance: ${original.archive}`,
    );
    if (original.disposition !== "unmanifested") {
      assert(item.runs.length > 0, `cleanup omitted run identity: ${original.archive}`);
    }
  }
  assert(report.totals.candidateBytes > 0, "cleanup selected no recoverable bytes");
  assert(report.totals.protectedBytes > 0, "cleanup did not report protected bytes");
}

export function recoveryTreeSnapshot(roots) {
  const entries = {};
  const visit = (file) => {
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) {
      return;
    }
    entries[file] = stat.isFile()
      ? { ...recoveryFileIdentity(file), mode: String(stat.mode) }
      : stat.isSymbolicLink()
        ? { link: fs.readlinkSync(file) }
        : { directory: true, mode: String(stat.mode), mtimeNs: String(stat.mtimeNs) };
    if (stat.isDirectory()) {
      for (const name of fs
        .readdirSync(file)
        .toSorted((left, right) => left.localeCompare(right))) {
        visit(path.join(file, name));
      }
    }
  };
  for (const root of [...new Set(roots.filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    visit(root);
  }
  return entries;
}

// Read-only SQLite connections may update the transient WAL index (sqlite.org/wal.html).
// Keep previews completely strict and keep database/WAL bytes strict during maintenance.
export function recoveryWalIndexPaths(stateDir, moves) {
  return [
    ...new Set([
      path.join(stateDir, "state", "openclaw.sqlite-shm"),
      ...moves.map((move) => `${move.sqlitePath}-shm`),
    ]),
  ];
}

export function assertRecoverySnapshot(
  before,
  after,
  allowedFiles = [],
  allowDirectoryTimes = false,
) {
  const allowed = new Set(allowedFiles);
  const project = (snapshot) =>
    Object.fromEntries(
      Object.entries(snapshot)
        .filter(([file]) => !allowed.has(file))
        .map(([file, entry]) => {
          if (allowDirectoryTimes && entry.directory) {
            const { mtimeNs: _mtime, ...rest } = entry;
            return [file, rest];
          }
          return [file, entry];
        }),
    );
  assert.deepEqual(
    project(after),
    project(before),
    "cleanup mutated files outside its declared payloads/receipts",
  );
}

export function recoveryHistoryMessages(history) {
  assert(Array.isArray(history.messages), "chat.history omitted messages");
  return history.messages.map(({ __openclaw: identity, role, content }) => {
    assert(typeof identity?.id === "string", "chat.history omitted message identity");
    return { id: identity.id, role, content };
  });
}

export function assertRecoveryHistory(history, sessionId, expected) {
  assert.equal(history.sessionId, sessionId, "history identity changed");
  assert.deepEqual(recoveryHistoryMessages(history), expected, "history content or order changed");
}

export function assertRecoveryApplied(report, preview, originals, moves) {
  assert.equal(report.status, "complete");
  assert.equal(report.dryRun, false);
  const removed = report.artifacts.filter((item) => item.outcome === "removed");
  assert(removed.length > 0, "cleanup removed nothing");
  assert.equal(report.totals.removedFiles, removed.length);
  assert.equal(
    report.totals.removedBytes,
    removed.reduce((total, item) => total + item.removedBytes, 0),
  );
  for (const item of removed) {
    const selected = preview.artifacts.find((entry) => entry.path === item.path);
    assert.equal(selected?.outcome, "candidate", `removed unselected artifact: ${item.path}`);
    assert.equal(item.removedBytes, selected.bytes);
    assert.equal(item.reason, "rollback-original-retired");
    assert(!fs.existsSync(item.path), `reported removal still exists: ${item.path}`);
    const receipts = moves.filter((move) => move.archivePath === item.path);
    assert(receipts.length > 0, `missing disposal receipt: ${item.path}`);
    for (const move of receipts) {
      assert.equal(
        move.artifact?.disposal.state,
        "disposed",
        `incomplete disposal receipt: ${item.path}`,
      );
      assert(move.artifact.disposal.disposedAt, `missing disposal time: ${item.path}`);
    }
  }
  for (const original of originals) {
    if (original.disposition === "candidate") {
      assert(
        removed.some((item) => item.path === original.archive),
        `eligible original retained: ${original.archive}`,
      );
    } else {
      assert.deepEqual(
        recoveryFileIdentity(original.archive),
        original.identity,
        `protected original changed: ${original.archive}`,
      );
    }
  }
  return removed.map((item) => item.path);
}
