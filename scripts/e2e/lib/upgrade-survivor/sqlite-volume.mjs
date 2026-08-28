import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const VOLUME_AGENT_IDS = ["main", "ops"];
const VOLUME_CRON_CREATED_AT_MS = Date.parse("2026-07-01T10:00:00.000Z");
const PREEXISTING_SESSION_FIXTURES = [
  {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "upgrade-main-session",
  },
  {
    agentId: "main",
    sessionKey: "agent:main:+15551234567",
    sessionId: "upgrade-direct-session",
  },
  {
    agentId: "main",
    sessionKey: "agent:main:slack:channel:cupgrade",
    sessionId: "upgrade-group-session",
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertJsonEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  assert(/^[1-9][0-9]*$/u.test(raw), `${name} must be a positive integer`);
  const value = Number(raw);
  assert(Number.isSafeInteger(value), `${name} must be a safe positive integer`);
  return value;
}

function getVolumeSpec() {
  return {
    sessions: readPositiveIntegerEnv("OPENCLAW_UPGRADE_SURVIVOR_VOLUME_SESSIONS", 4800),
    eventsPerSession: readPositiveIntegerEnv(
      "OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION",
      5,
    ),
    cronJobs: readPositiveIntegerEnv("OPENCLAW_UPGRADE_SURVIVOR_VOLUME_CRON_JOBS", 2200),
  };
}

function getVolumeSessionFixture(index) {
  const agentId = VOLUME_AGENT_IDS[index % VOLUME_AGENT_IDS.length];
  const paddedIndex = String(index).padStart(6, "0");
  const sessionId =
    index === 0
      ? "volume-main-unicode-000000"
      : index === 1
        ? "volume-ops-combining-000001"
        : index === 2
          ? `volume-main-${"x".repeat(116)}`
          : `volume-${agentId}-${paddedIndex}`;
  const target =
    index === 1
      ? `naïve-user-${paddedIndex}`
      : index % 3 === 0
        ? `channel-${paddedIndex}:thread:${index % 97}`
        : `user-${paddedIndex}`;
  const sessionKey =
    index % 3 === 0
      ? `agent:${agentId}:slack:channel:${target}`
      : index % 3 === 1
        ? `agent:${agentId}:discord:personal:direct:${target}`
        : `agent:${agentId}:telegram:group:-1000000000000:topic:${target}`;
  return {
    agentId,
    label: index % 17 === 0 ? `Volume user ${index} — 東京` : `Volume user ${index}`,
    metadataOnly: index === 4 || index % 401 === 400,
    missingTranscript: index === 5 || index % 503 === 502,
    sessionId,
    sessionKey,
  };
}

function getVolumeSessionsDir(stateDir, agentId) {
  return path.join(stateDir, "agents", agentId, "sessions");
}

function getVolumeTranscriptEvent(index, sessionId, sequence) {
  if (sequence === 0) {
    return {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-07-01T10:00:00.000Z",
      cwd: "/tmp/openclaw-upgrade-survivor-workspace",
    };
  }
  const textSize = sequence % 3 === 1 ? 257 : sequence % 3 === 2 ? 1025 : 32;
  return {
    type: "message",
    id: `${sessionId}-event-${sequence}`,
    parentId: sequence === 1 ? null : `${sessionId}-event-${sequence - 1}`,
    timestamp: new Date(VOLUME_CRON_CREATED_AT_MS + sequence * 1000).toISOString(),
    message: {
      role: sequence % 2 === 0 ? "assistant" : "user",
      content: [{ type: "text", text: `${index}:${sequence}:λ${"x".repeat(textSize)}` }],
    },
  };
}

function getVolumeCronJob(index) {
  const paddedIndex = String(index).padStart(6, "0");
  return {
    id: `volume-cron-${paddedIndex}`,
    name: index === 0 ? "Archive crawl — 東京" : `Archive crawl ${paddedIndex}`,
    enabled: index % 5 !== 0,
    createdAtMs: VOLUME_CRON_CREATED_AT_MS + index,
    updatedAtMs: VOLUME_CRON_CREATED_AT_MS + index,
    schedule: {
      kind: "every",
      everyMs: 86_400_000,
      anchorMs: VOLUME_CRON_CREATED_AT_MS + index,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    delivery: { mode: "none" },
    payload: {
      kind: "agentTurn",
      message: `crawl archive partition ${paddedIndex} ${"z".repeat((index % 5) * 128)}`.trimEnd(),
    },
    state: {
      nextRunAtMs: VOLUME_CRON_CREATED_AT_MS + 365 * 86_400_000 + index,
      ...(index % 11 === 0 ? { lastStatus: "error", lastError: "stale crawl lease" } : {}),
      crawlCursor: { partition: paddedIndex, offset: index * 1000 },
    },
  };
}

function getVolumeSessionFixtures(spec) {
  return Array.from({ length: spec.sessions }, (_, index) => ({
    index,
    ...getVolumeSessionFixture(index),
  }));
}

function assertVolumeSessionStores(stores, fixtures, context) {
  for (const agentId of VOLUME_AGENT_IDS) {
    const expectedCount = [...fixtures, ...PREEXISTING_SESSION_FIXTURES].filter(
      (fixture) => fixture.agentId === agentId,
    ).length;
    assert(
      Object.keys(stores.get(agentId) ?? {}).length === expectedCount,
      `${agentId} ${context} session-store count changed`,
    );
  }
  for (const fixture of fixtures) {
    const entry = stores.get(fixture.agentId)?.[fixture.sessionKey];
    assert(
      entry?.sessionId === fixture.sessionId,
      `${context} session row changed: ${fixture.index}`,
    );
    assert(entry?.label === fixture.label, `${context} session label changed: ${fixture.index}`);
    assert(
      fixture.metadataOnly === !Object.hasOwn(entry, "sessionFile"),
      `${context} session transcript ownership changed: ${fixture.index}`,
    );
  }
  for (const fixture of PREEXISTING_SESSION_FIXTURES) {
    assert(
      stores.get(fixture.agentId)?.[fixture.sessionKey]?.sessionId === fixture.sessionId,
      `${context} preexisting session changed: ${fixture.sessionKey}`,
    );
  }
}

function assertVolumeCronJobs(jobs, spec, context) {
  assert(jobs.length === spec.cronJobs, `${context} cron fixture count changed`);
  for (let index = 0; index < spec.cronJobs; index += 1) {
    const expected = getVolumeCronJob(index);
    const actual = jobs[index];
    assert(actual?.id === expected.id, `${context} cron identity changed: ${index}`);
    assert(
      actual?.payload?.message === expected.payload.message,
      `${context} cron changed: ${index}`,
    );
  }
}

function seedUpgradeVolumeSessions(stateDir) {
  const stores = new Map(
    VOLUME_AGENT_IDS.map((agentId) => {
      const sessionsDir = getVolumeSessionsDir(stateDir, agentId);
      const storePath = path.join(sessionsDir, "sessions.json");
      return [
        agentId,
        {
          sessionsDir,
          store: fs.existsSync(storePath) ? readJson(storePath) : {},
        },
      ];
    }),
  );
  const spec = getVolumeSpec();
  const baseUpdatedAt = Date.now() - 12 * 60 * 60 * 1000;
  for (let index = 0; index < spec.sessions; index += 1) {
    const { agentId, label, metadataOnly, missingTranscript, sessionId, sessionKey } =
      getVolumeSessionFixture(index);
    const target = stores.get(agentId);
    assert(target, `unknown volume fixture agent: ${agentId}`);
    const { sessionsDir, store } = target;
    store[sessionKey] = {
      sessionId,
      ...(metadataOnly ? {} : { sessionFile: path.join(sessionsDir, `${sessionId}.jsonl`) }),
      provider: "openai",
      model: "gpt-5.5",
      updatedAt: baseUpdatedAt + index,
      label,
    };
    if (metadataOnly || missingTranscript) {
      continue;
    }
    const events = Array.from({ length: spec.eventsPerSession }, (_, sequence) =>
      JSON.stringify(getVolumeTranscriptEvent(index, sessionId, sequence)),
    );
    write(path.join(sessionsDir, `${sessionId}.jsonl`), `${events.join("\n")}\n`);
  }
  for (let index = 0; index < 24; index += 1) {
    const agentId = VOLUME_AGENT_IDS[index % VOLUME_AGENT_IDS.length];
    write(
      path.join(
        getVolumeSessionsDir(stateDir, agentId),
        `deleted-orphan-${String(index).padStart(2, "0")}.jsonl`,
      ),
      `${JSON.stringify({ type: "message", id: `deleted-orphan-${index}` })}\n`,
    );
  }
  for (const { sessionsDir, store } of stores.values()) {
    writeJson(path.join(sessionsDir, "sessions.json"), store);
  }
}

function seedUpgradeVolumeCronJobs(stateDir) {
  const spec = getVolumeSpec();
  const jobs = Array.from({ length: spec.cronJobs }, (_, index) => getVolumeCronJob(index));
  writeJson(path.join(stateDir, "cron", "jobs.json"), { version: 1, jobs });
}

export function seedUpgradeVolume(stateDir) {
  seedUpgradeVolumeSessions(stateDir);
  seedUpgradeVolumeCronJobs(stateDir);
}

function assertHealthySqlite(databasePath, assertContents) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let contents;
  try {
    assert(
      db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal",
      `${databasePath} is not WAL`,
    );
    assert(
      db.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok",
      `${databasePath} failed integrity_check`,
    );
    assert(
      db.prepare("PRAGMA foreign_key_check").all().length === 0,
      `${databasePath} has FK errors`,
    );
    contents = assertContents(db);
  } finally {
    db.close();
  }
  const reopened = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert(
      reopened.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok",
      `${databasePath} failed reopen`,
    );
  } finally {
    reopened.close();
  }
  return contents;
}

export function assertUpgradeVolumeMigrated(stateDir, stage) {
  const spec = getVolumeSpec();
  const fixtures = getVolumeSessionFixtures(spec);
  const legacyCronPath = path.join(stateDir, "cron", "jobs.json");
  if (stage === "baseline") {
    const stores = new Map(
      VOLUME_AGENT_IDS.map((agentId) => [
        agentId,
        readJson(path.join(getVolumeSessionsDir(stateDir, agentId), "sessions.json")),
      ]),
    );
    assertVolumeSessionStores(stores, fixtures, "volume baseline");
    for (const fixture of fixtures) {
      if (fixture.missingTranscript) {
        assert(
          !fs.existsSync(
            path.join(
              getVolumeSessionsDir(stateDir, fixture.agentId),
              `${fixture.sessionId}.jsonl`,
            ),
          ),
          `volume missing transcript fixture unexpectedly exists: ${fixture.index}`,
        );
      }
    }
    assertVolumeCronJobs(readJson(legacyCronPath).jobs ?? [], spec, "volume baseline");
    return;
  }

  for (const agentId of VOLUME_AGENT_IDS) {
    assert(
      !fs.existsSync(path.join(getVolumeSessionsDir(stateDir, agentId), "sessions.json")),
      `${agentId} volume legacy session store remained active`,
    );
  }
  assert(!fs.existsSync(legacyCronPath), "volume legacy cron store remained active");
  let migratedSessions = 0;
  let migratedEvents = 0;
  for (const agentId of VOLUME_AGENT_IDS) {
    const agentFixtures = fixtures.filter((fixture) => fixture.agentId === agentId);
    const expectedEvents =
      agentFixtures.filter((fixture) => !fixture.metadataOnly && !fixture.missingTranscript)
        .length * spec.eventsPerSession;
    const databasePath = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
    const counts = assertHealthySqlite(databasePath, (db) => {
      const sessionRows = db
        .prepare(
          "SELECT session_key, current_session_id, entry_json FROM session_nodes WHERE current_session_id LIKE 'volume-%'",
        )
        .all();
      const windowRows = db
        .prepare(
          "SELECT session_id, session_key FROM session_windows WHERE session_id LIKE 'volume-%'",
        )
        .all();
      const eventRows = db
        .prepare(
          "SELECT session_id, seq, event_json FROM transcript_events WHERE session_id LIKE 'volume-%'",
        )
        .all();
      const sessionsByKey = new Map(sessionRows.map((row) => [row.session_key, row]));
      const windowsById = new Map(windowRows.map((row) => [row.session_id, row]));
      const missingSessions = agentFixtures
        .filter((fixture) => !sessionsByKey.has(fixture.sessionKey))
        .map((fixture) => fixture.index);
      assert(
        sessionRows.length === agentFixtures.length,
        `${agentId} volume session count changed: ${sessionRows.length}; missing indexes: ${missingSessions.join(", ")}`,
      );
      assert(
        windowRows.length === agentFixtures.length,
        `${agentId} volume session window count changed: ${windowRows.length}`,
      );
      assert(
        eventRows.length === expectedEvents,
        `${agentId} volume event count changed: ${eventRows.length}`,
      );
      const eventsByIdAndSequence = new Map(
        eventRows.map((row) => [`${row.session_id}\0${row.seq}`, row]),
      );
      for (const fixture of agentFixtures) {
        const row = sessionsByKey.get(fixture.sessionKey);
        assert(
          row?.current_session_id === fixture.sessionId,
          `volume session changed: ${fixture.index}`,
        );
        const entry = JSON.parse(row?.entry_json ?? "null");
        assert(entry?.sessionId === fixture.sessionId, `volume entry changed: ${fixture.index}`);
        assert(entry?.label === fixture.label, `volume label changed: ${fixture.index}`);
        assert(
          entry?.provider === "openai" || entry?.delivery?.origin?.provider === "openai",
          `volume provider changed: ${fixture.index}`,
        );
        assert(entry?.model === "gpt-5.5", `volume model changed: ${fixture.index}`);
        assert(
          !Object.hasOwn(entry, "sessionFile"),
          `volume session retained retired sessionFile metadata: ${fixture.index}`,
        );
        assert(
          windowsById.get(fixture.sessionId)?.session_key === fixture.sessionKey,
          `volume session window changed: ${fixture.index}`,
        );
        if (fixture.metadataOnly || fixture.missingTranscript) {
          continue;
        }
        for (let sequence = 0; sequence < spec.eventsPerSession; sequence += 1) {
          const event = eventsByIdAndSequence.get(`${fixture.sessionId}\0${sequence}`);
          const expected = getVolumeTranscriptEvent(fixture.index, fixture.sessionId, sequence);
          assertJsonEqual(
            JSON.parse(event?.event_json ?? "null"),
            expected,
            `volume transcript event changed: ${fixture.index}:${sequence}`,
          );
        }
      }
      return { sessions: sessionRows.length, events: eventRows.length };
    });
    migratedSessions += counts.sessions;
    migratedEvents += counts.events;
  }
  assert(migratedSessions === spec.sessions, `volume session count changed: ${migratedSessions}`);

  const stateDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
  assertHealthySqlite(stateDatabasePath, (db) => {
    const rows = db
      .prepare(
        `SELECT job_id, job_json, state_json, enabled, payload_kind, updated_at,
                runtime_updated_at_ms
         FROM cron_jobs
         WHERE job_id LIKE 'volume-cron-%'`,
      )
      .all();
    assert(rows.length === spec.cronJobs, `volume cron job count changed: ${rows.length}`);
    const jobsById = new Map(rows.map((row) => [row.job_id, row]));
    for (let index = 0; index < spec.cronJobs; index += 1) {
      const expected = getVolumeCronJob(index);
      const row = jobsById.get(expected.id);
      const actual = JSON.parse(row?.job_json ?? "null");
      for (const field of [
        "id",
        "name",
        "enabled",
        "createdAtMs",
        "schedule",
        "sessionTarget",
        "wakeMode",
        "delivery",
        "payload",
      ]) {
        assertJsonEqual(actual?.[field], expected[field], `volume cron ${field} changed: ${index}`);
      }
      assert(row?.updated_at === expected.updatedAtMs, `volume cron timestamp changed: ${index}`);
      assert(
        row?.runtime_updated_at_ms === expected.updatedAtMs,
        `volume cron runtime timestamp changed: ${index}`,
      );
      const actualState = JSON.parse(row?.state_json ?? "null");
      assertJsonEqual(
        actualState?.crawlCursor,
        expected.state.crawlCursor,
        `volume cron residual state changed: ${index}`,
      );
      assert(
        row?.enabled === (expected.enabled ? 1 : 0),
        `volume cron enabled column changed: ${index}`,
      );
      assert(row?.payload_kind === "agentTurn", `volume cron payload kind changed: ${index}`);
      assert(
        (actualState?.nextRunAtMs ?? null) ===
          (expected.enabled ? expected.state.nextRunAtMs : null),
        `volume cron next-run state changed: ${index}`,
      );
      assert(
        (actualState?.runningAtMs ?? null) === null,
        `volume cron running state changed: ${index}`,
      );
      assert(
        (actualState?.lastRunStatus ?? actualState?.lastStatus ?? null) ===
          (expected.state.lastStatus ?? null),
        `volume cron status state changed: ${index}`,
      );
      assert(
        (actualState?.lastError ?? null) === (expected.state.lastError ?? null),
        `volume cron error state changed: ${index}`,
      );
    }
  });

  const archivedStores = new Map();
  const archivedTranscripts = new Map();
  for (const agentId of VOLUME_AGENT_IDS) {
    const archiveDir = path.join(stateDir, "agents", agentId, "session-sqlite-import-archive");
    assert(fs.existsSync(archiveDir), `${agentId} volume session migration archive missing`);
    const entries = fs.readdirSync(archiveDir);
    const storeEntries = entries.filter((entry) =>
      /\.sessions\.json\.imported-\d+(?:\.\d+)?$/u.test(entry),
    );
    assert(storeEntries.length === 1, `${agentId} volume legacy session-store archive changed`);
    archivedStores.set(agentId, readJson(path.join(archiveDir, storeEntries[0])));

    const transcriptsByName = new Map();
    for (const entry of entries) {
      const match = /\.([^.]+\.jsonl)\.imported-\d+(?:\.\d+)?$/u.exec(entry);
      if (match?.[1]) {
        transcriptsByName.set(match[1], entry);
      }
    }
    const expectedTranscriptCount =
      fixtures.filter(
        (fixture) =>
          fixture.agentId === agentId && !fixture.metadataOnly && !fixture.missingTranscript,
      ).length +
      PREEXISTING_SESSION_FIXTURES.filter((fixture) => fixture.agentId === agentId).length +
      12;
    assert(
      transcriptsByName.size === expectedTranscriptCount,
      `${agentId} volume transcript archive count changed: ${transcriptsByName.size}`,
    );
    archivedTranscripts.set(agentId, { archiveDir, transcriptsByName });
  }
  assertVolumeSessionStores(archivedStores, fixtures, "archived volume");
  for (const fixture of fixtures) {
    if (fixture.metadataOnly || fixture.missingTranscript) {
      continue;
    }
    assert(
      archivedTranscripts.get(fixture.agentId)?.transcriptsByName.has(`${fixture.sessionId}.jsonl`),
      `referenced volume transcript was not archived: ${fixture.index}`,
    );
  }
  for (const fixture of PREEXISTING_SESSION_FIXTURES) {
    assert(
      archivedTranscripts.get(fixture.agentId)?.transcriptsByName.has(`${fixture.sessionId}.jsonl`),
      `preexisting transcript was not archived: ${fixture.sessionId}`,
    );
  }
  for (let index = 0; index < 24; index += 1) {
    const orphan = `deleted-orphan-${String(index).padStart(2, "0")}.jsonl`;
    const agentId = VOLUME_AGENT_IDS[index % VOLUME_AGENT_IDS.length];
    assert(
      archivedTranscripts.get(agentId)?.transcriptsByName.has(orphan),
      `unreferenced volume transcript was not archived: ${orphan}`,
    );
  }
  for (const index of [0, 1, 2]) {
    const fixture = getVolumeSessionFixture(index);
    const archived = archivedTranscripts.get(fixture.agentId);
    const entry = archived?.transcriptsByName.get(`${fixture.sessionId}.jsonl`);
    assert(archived && entry, `archived volume transcript sample missing: ${index}`);
    const events = fs
      .readFileSync(path.join(archived.archiveDir, entry), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const expected = Array.from({ length: spec.eventsPerSession }, (_, sequence) =>
      getVolumeTranscriptEvent(index, fixture.sessionId, sequence),
    );
    assertJsonEqual(events, expected, `archived volume transcript changed: ${index}`);
  }

  const cronArchiveEntries = fs
    .readdirSync(path.dirname(legacyCronPath))
    .filter((entry) => /^jobs\.json\.migrated(?:\.\d+)?$/u.test(entry));
  assert(cronArchiveEntries.length === 1, "volume legacy cron archive count changed");
  const archivedCronJobs = readJson(
    path.join(path.dirname(legacyCronPath), cronArchiveEntries[0]),
  ).jobs;
  assertVolumeCronJobs(archivedCronJobs ?? [], spec, "archived volume");
  process.stdout.write(
    `sqlite-volume sessions=${migratedSessions} events=${migratedEvents} cronJobs=${spec.cronJobs}\n`,
  );
}
