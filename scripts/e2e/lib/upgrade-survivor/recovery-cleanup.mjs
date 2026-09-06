#!/usr/bin/env node
// Installed-package proof only. No migration, cleanup, or session implementation imports.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveNpmJsonEntries } from "../../../lib/npm-json-output.mts";
import {
  assertRecoveryApplied,
  assertRecoveryHistory,
  assertRecoveryInventory,
  assertRecoveryOriginals,
  assertRecoverySnapshot,
  readRecoveryJson,
  readRecoveryMoves,
  recoveryEvent,
  recoveryFileIdentity,
  recoveryHistoryMessages,
  recoveryTreeSnapshot,
  recoveryVolumeSpec,
  recoveryWalIndexPaths,
  seedRecoveryFixture,
  writeRecoveryJson,
  writeRecoveryTranscript,
} from "./recovery-cleanup-fixture.mjs";

const run = promisify(execFile);
const stateDir = process.env.OPENCLAW_STATE_DIR;
const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const runtimeRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
assert(stateDir && artifactRoot && runtimeRoot, "recovery proof requires isolated survivor roots");
const evidencePath = path.join(artifactRoot, "recovery-evidence.json");
const fixturePath = path.join(artifactRoot, "recovery-fixture.json");
const metricsPath = path.join(artifactRoot, "recovery-resources.tsv");
const measurePath = "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs";
const outputPath = (name, suffix = "json") => path.join(artifactRoot, `recovery-${name}.${suffix}`);
const saveEvidence = (patch) =>
  writeRecoveryJson(evidencePath, {
    ...(fs.existsSync(evidencePath) ? readRecoveryJson(evidencePath) : {}),
    ...patch,
  });

async function command(
  name,
  argv,
  { env = process.env, failure = false, measured = false, binary = "openclaw", json = true } = {},
) {
  let code = 0;
  let stdout;
  let stderr;
  const start = performance.now();
  try {
    const result = measured
      ? await run(
          process.execPath,
          [
            measurePath,
            metricsPath,
            name,
            "--",
            "bash",
            "-c",
            'out="$1"; err="$2"; shift 2; exec "$@" >"$out" 2>"$err"',
            "recovery-command",
            outputPath(name),
            outputPath(name, "err"),
            binary,
            ...argv,
          ],
          { env, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        )
      : await run(binary, argv, {
          env,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    // Do not retain execFile's error message/cause: it embeds token-bearing argv.
    code = typeof error.code === "number" ? error.code : 1;
    stdout = error.stdout || "";
    stderr = error.stderr || "";
  }
  if (measured) {
    fs.writeFileSync(outputPath(name, "metrics.log"), stdout + stderr);
    stdout = fs.readFileSync(outputPath(name), "utf8");
  } else {
    fs.writeFileSync(outputPath(name), stdout);
    fs.writeFileSync(outputPath(name, "err"), stderr);
  }
  assert(
    failure ? code !== 0 : code === 0,
    `${name}: unexpected exit ${code}; see recovery-${name}.err`,
  );
  const result = json ? JSON.parse(stdout) : stdout;
  writeRecoveryJson(outputPath(name, "command.json"), {
    argv,
    code,
    elapsedMs: performance.now() - start,
  });
  return result;
}

function roots() {
  // Output/metrics live in ARTIFACT_ROOT, outside this pure-preview snapshot.
  return [
    process.env.HOME,
    stateDir,
    process.env.OPENCLAW_CONFIG_PATH,
    process.env.TMPDIR,
    process.env.npm_config_cache,
  ];
}

function preservedFiles(originals) {
  const files = [
    ...originals.map((item) => item.archive),
    process.env.OPENCLAW_CONFIG_PATH,
    ...readRecoveryMoves(stateDir).map((move) => move.manifestPath),
  ];
  return Object.fromEntries(
    [...new Set(files)]
      .toSorted((left, right) => left.localeCompare(right))
      .map((file) => [file, recoveryFileIdentity(file)]),
  );
}

async function cleanup(name, flags, options) {
  const result = await command(name, ["update", "cleanup", ...flags, "--json"], options);
  assert.equal(result.stateDir, stateDir, "cleanup selected another state root");
  return result;
}

async function gateway(name, method, params) {
  const token = process.env.GATEWAY_AUTH_TOKEN_REF;
  assert(token, "fixture Gateway token missing");
  return await command(name, [
    "gateway",
    "call",
    method,
    "--url",
    "ws://127.0.0.1:18789",
    "--token",
    token,
    "--timeout",
    "30000",
    "--json",
    "--params",
    JSON.stringify(params),
  ]);
}

async function readHistory(name, fixture) {
  const listing = await gateway(`${name}-list`, "sessions.list", {
    agentId: fixture.agentId,
    label: fixture.sessionId,
    limit: 2,
  });
  assert.equal(listing.sessions.length, 1, "conversation not uniquely listed");
  assert.equal(listing.sessions[0].key, fixture.sessionKey);
  assert.equal(listing.sessions[0].sessionId, fixture.sessionId);
  return await gateway(name, "chat.history", {
    agentId: fixture.agentId,
    sessionKey: fixture.sessionKey,
    limit: 20,
  });
}

async function inspect(name) {
  const result = await command(name, [
    "doctor",
    "--session-sqlite",
    "inspect",
    "--session-sqlite-all-agents",
    "--json",
  ]);
  assert(result.totals.sqliteEntries > 0, "Doctor inspection found no current sessions");
  return result.totals.sqliteEntries;
}

async function proveHistory(stage, append) {
  const fixture = readRecoveryJson(fixturePath);
  const evidence = readRecoveryJson(evidencePath);
  const saved = [];
  for (const conversation of fixture.histories) {
    const expected = [];
    for (
      let sequence = Math.max(1, conversation.count - 20);
      sequence < conversation.count;
      sequence += 1
    ) {
      const event = recoveryEvent(conversation.sessionId, sequence, conversation.large);
      expected.push({ id: event.id, role: event.message.role, content: event.message.content });
    }
    const history = await readHistory(`${stage}-${conversation.sessionId}`, conversation);
    const previous = evidence.histories?.find(
      (entry) => entry.sessionId === conversation.sessionId,
    );
    assertRecoveryHistory(history, conversation.sessionId, previous?.messages ?? expected);
    if (conversation.sessionId === "recovery-branch") {
      const reply = history.messages.find((message) => message.role === "assistant");
      assert.equal(reply?.provider, "openai", "legacy provider metadata was not normalized");
      assert.equal(
        reply?.api,
        "openai-chatgpt-responses",
        "legacy API metadata was not normalized",
      );
    }
    saved.push({ ...conversation, messages: recoveryHistoryMessages(history) });
  }
  if (append) {
    const old = saved.find((entry) => entry.sessionId === "recovery-old");
    const message = "history appended after the real package upgrade";
    const injected = await gateway("append-old", "chat.inject", {
      agentId: old.agentId,
      sessionKey: old.sessionKey,
      message,
    });
    assert(injected.ok && injected.messageId, "chat.inject did not commit old-session history");
    old.messages.push({
      id: injected.messageId,
      role: "assistant",
      content: [{ type: "text", text: message }],
    });
    assertRecoveryHistory(await readHistory("old-appended", old), old.sessionId, old.messages);
    const created = await gateway("create-new", "sessions.create", {
      agentId: "recovery-clean",
      key: "agent:recovery-clean:recovery-new",
      label: "recovery-new",
    });
    assert(
      created.ok && created.sessionId && created.key,
      "sessions.create did not persist a session",
    );
    assert.equal(created.runStarted, false, "fixture unexpectedly started inference");
    const fresh = {
      agentId: "recovery-clean",
      sessionId: created.sessionId,
      sessionKey: created.key,
    };
    const newMessage = "new conversation created through the public Gateway after upgrade";
    const newInjected = await gateway("append-new", "chat.inject", {
      agentId: fresh.agentId,
      sessionKey: fresh.sessionKey,
      message: newMessage,
    });
    assert(newInjected.ok && newInjected.messageId, "new conversation append failed");
    const history = await gateway("new-history", "chat.history", {
      agentId: fresh.agentId,
      sessionKey: fresh.sessionKey,
      limit: 20,
    });
    const messages = [
      {
        id: newInjected.messageId,
        role: "assistant",
        content: [{ type: "text", text: newMessage }],
      },
    ];
    assertRecoveryHistory(history, fresh.sessionId, messages);
    saveEvidence({ histories: saved, newHistory: { ...fresh, messages } });
  } else {
    const fresh = evidence.newHistory;
    const history = await gateway(`${stage}-new-history`, "chat.history", {
      agentId: fresh.agentId,
      sessionKey: fresh.sessionKey,
      limit: 20,
    });
    assertRecoveryHistory(history, fresh.sessionId, fresh.messages);
    const hashes = [...saved, fresh].map((entry) => ({
      sessionKey: entry.sessionKey,
      sessionId: entry.sessionId,
      messagesSha256: createHash("sha256").update(JSON.stringify(entry.messages)).digest("hex"),
    }));
    saveEvidence({
      [stage]: { histories: hashes, sqliteEntries: await inspect(`${stage}-inspect`) },
    });
  }
}

async function live() {
  await proveHistory("before-cleanup", true);
  const originals = readRecoveryJson(evidencePath).originals;
  const before = preservedFiles(originals);
  const preview = await cleanup("live-preview", ["--dry-run"]);
  assertRecoveryInventory(preview, originals);
  assert.deepEqual(preservedFiles(originals), before, "live preview mutated recovery/config files");
  const refused = await cleanup("live-apply", ["--yes"], { failure: true });
  assert.equal(refused.status, "blocked");
  assert.match(
    refused.error ?? "",
    /Gateway|maintenance/iu,
    "live refusal did not report ownership",
  );
  assert.equal(refused.totals?.removedBytes ?? 0, 0);
  assert.deepEqual(preservedFiles(originals), before, "live apply changed recovery/config files");
  const wrongEnv = { ...process.env };
  delete wrongEnv.OPENCLAW_STATE_DIR;
  delete wrongEnv.OPENCLAW_CONFIG_PATH;
  delete wrongEnv.OPENCLAW_PROFILE;
  const wrong = await command(
    "wrong-profile",
    ["--profile", "recovery-other", "update", "cleanup", "--yes", "--json"],
    { env: wrongEnv },
  );
  assert.notEqual(wrong.stateDir, stateDir);
  assert.equal(wrong.totals.removedFiles, 0);
  assert.deepEqual(preservedFiles(originals), before, "wrong-profile cleanup touched the fixture");
  await proveHistory("after-live-refusal", false);
  saveEvidence({
    live: { preview: preview.totals, refusal: refused.status, wrongProfile: wrong.stateDir },
  });
}

async function offline() {
  const originals = readRecoveryJson(evidencePath).originals;
  const entries = await inspect("offline-before");
  const before = recoveryTreeSnapshot(roots());
  const preview = await cleanup("offline-preview", ["--dry-run"]);
  assertRecoveryInventory(preview, originals);
  assertRecoverySnapshot(before, recoveryTreeSnapshot(roots()));
  const noConsent = await cleanup("no-consent", [], { failure: true });
  assert.equal(noConsent.status, "refused");
  assertRecoverySnapshot(before, recoveryTreeSnapshot(roots()));
  const apply = await cleanup("apply", ["--yes"], { measured: true });
  const moves = readRecoveryMoves(stateDir);
  const removed = assertRecoveryApplied(apply, preview, originals, moves);
  const receipts = [
    ...new Set(
      moves.filter((move) => removed.includes(move.archivePath)).map((move) => move.manifestPath),
    ),
  ];
  const walIndexes = recoveryWalIndexPaths(stateDir, moves);
  assertRecoverySnapshot(
    before,
    recoveryTreeSnapshot(roots()),
    [...removed, ...receipts, ...walIndexes],
    true,
  );
  const retryBefore = recoveryTreeSnapshot(roots());
  const retry = await cleanup("retry", ["--yes"]);
  assert.equal(retry.status, "complete");
  assert.equal(retry.totals.removedFiles, 0);
  assert.equal(retry.totals.removedBytes, 0);
  assertRecoverySnapshot(retryBefore, recoveryTreeSnapshot(roots()), walIndexes, true);
  const recreated = removed[0];
  fs.writeFileSync(recreated, "replacement at an intentionally disposed archive path\n", {
    flag: "wx",
  });
  const replacementBefore = recoveryTreeSnapshot(roots());
  const replacement = await cleanup("replacement", ["--yes"]);
  assert.equal(replacement.totals.removedBytes, 0);
  assertRecoverySnapshot(replacementBefore, recoveryTreeSnapshot(roots()), walIndexes, true);
  assert.equal(await inspect("offline-after"), entries, "cleanup changed current session totals");
  saveEvidence({
    offline: {
      preview: preview.totals,
      apply: apply.totals,
      retry: retry.totals,
      recreated,
      recreatedIdentity: recoveryFileIdentity(recreated),
      replacement: replacement.totals,
      sqliteEntries: entries,
      removed,
      receipts,
      databaseBytesUnchanged: true,
    },
  });
}

async function customRestore() {
  const primaryBefore = recoveryTreeSnapshot([stateDir]);
  const home = path.join(runtimeRoot, "recovery-restore-home");
  const customState = path.join(home, ".openclaw");
  const store = path.join(customState, "custom-sessions", "sessions.json");
  const transcript = path.join(path.dirname(store), "restore-original.jsonl");
  const customConfig = path.join(customState, "openclaw.json");
  const agentDir = path.join(customState, "custom-agents", "main");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: customState,
    OPENCLAW_CONFIG_PATH: customConfig,
  };
  fs.mkdirSync(home, { recursive: true });
  await command(
    "restore-config",
    [
      "config",
      "set",
      "agents",
      JSON.stringify({
        defaults: { heartbeat: { every: "0m" } },
        list: [{ id: "main", default: true, agentDir, workspace: path.join(home, "workspace") }],
      }),
      "--strict-json",
    ],
    { env, json: false },
  );
  await command("restore-store-config", ["config", "set", "session.store", store], {
    env,
    json: false,
  });
  writeRecoveryTranscript(transcript, "restore-original", 3);
  writeRecoveryJson(store, {
    "agent:main:restore-original": {
      sessionId: "restore-original",
      sessionFile: transcript,
      updatedAt: Date.now(),
    },
  });
  const originals = [store, transcript].map((source) => ({
    source,
    identity: recoveryFileIdentity(source),
  }));
  // Public Doctor owns both migrations. Restore never touches the primary Gateway histories.
  await command(
    "restore-import",
    ["doctor", "--session-sqlite", "import", "--session-sqlite-all-agents", "--json"],
    { env, measured: true },
  );
  const restored = await command(
    "restore-before",
    ["doctor", "--session-sqlite", "restore", "--session-sqlite-store", store, "--json"],
    { env },
  );
  const restoredFiles = restored.targets.flatMap((target) => target.restore?.restoredFiles ?? []);
  for (const original of originals) {
    assert(restoredFiles.includes(original.source), `restore omitted ${original.source}`);
    assert.deepEqual(recoveryFileIdentity(original.source), original.identity);
  }
  const consumed = await command(
    "restore-consumed-preview",
    ["update", "cleanup", "--dry-run", "--json"],
    { env },
  );
  assert(
    consumed.artifacts.some(
      (item) => item.reason === "archive-consumed-by-restore" && item.outcome === "protected",
    ),
    "restored originals lost their consumed receipt",
  );
  await command(
    "restore-reimport",
    ["doctor", "--session-sqlite", "import", "--session-sqlite-all-agents", "--json"],
    { env, measured: true },
  );
  const customPreview = await command(
    "restore-preview",
    ["update", "cleanup", "--dry-run", "--json"],
    { env },
  );
  const reimported = originals.map((original) => {
    const move = readRecoveryMoves(customState).find(
      (entry) => entry.sourcePath === original.source && fs.existsSync(entry.archivePath),
    );
    assert(move, `reimport did not preserve ${original.source}`);
    assert.deepEqual(recoveryFileIdentity(move.archivePath), original.identity);
    return { ...original, archive: move.archivePath, disposition: "candidate" };
  });
  const before = recoveryTreeSnapshot([customState]);
  const result = await command("restore-cleanup", ["update", "cleanup", "--yes", "--json"], {
    env,
  });
  assert.equal(result.status, "complete");
  assert(result.totals.removedBytes > 0, "reimported custom originals were not retired");
  const moves = readRecoveryMoves(customState);
  const walIndexes = recoveryWalIndexPaths(customState, moves);
  assertRecoveryApplied(result, customPreview, reimported, moves);
  assertRecoverySnapshot(
    before,
    recoveryTreeSnapshot([customState]),
    [
      ...result.artifacts.filter((item) => item.outcome === "removed").map((item) => item.path),
      ...moves.map((move) => move.manifestPath),
      ...walIndexes,
    ],
    true,
  );
  const beforeDisposedRestore = recoveryTreeSnapshot([customState]);
  const disposed = await command(
    "restore-disposed",
    ["doctor", "--session-sqlite", "restore", "--session-sqlite-store", store, "--json"],
    { env, failure: true },
  );
  const conflicts = disposed.targets.flatMap((target) => target.restore?.conflicts ?? []);
  for (const original of originals) {
    assert(
      conflicts.some(
        (entry) =>
          entry.sourcePath === original.source && entry.reason.includes("intentionally disposed"),
      ),
      "restore concealed intentional disposal",
    );
    assert(!fs.existsSync(original.source), "disposed restore recreated legacy history");
  }
  assertRecoverySnapshot(
    beforeDisposedRestore,
    recoveryTreeSnapshot([customState]),
    [...moves.map((move) => move.manifestPath), ...walIndexes],
    true,
  );
  assertRecoverySnapshot(primaryBefore, recoveryTreeSnapshot([stateDir]));
  saveEvidence({
    customRestore: { store, agentDir, restoredFiles, cleanup: result.totals, conflicts },
  });
}

async function packageEvidence() {
  const [baseline, candidate] = process.argv.slice(3);
  assert(baseline && candidate, "package evidence requires baseline and candidate");
  const version = process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION;
  assert(version, "package evidence requires the installed baseline version");
  // Resolve mutable tags once at installation; evidence must describe those same bytes.
  const exactBaseline = `openclaw@${version}`;
  const entries = resolveNpmJsonEntries(
    await command("baseline-package", ["view", exactBaseline, "version", "dist", "--json"], {
      binary: "npm",
    }),
  );
  assert.equal(entries.length, 1);
  const metadata = entries[0];
  assert(metadata && typeof metadata === "object");
  assert.equal(metadata.version, version);
  assert(typeof metadata.dist.integrity === "string" && metadata.dist.integrity.length > 0);
  // npm pack computes integrity from the fetched tarball even with --dry-run.
  const packed = resolveNpmJsonEntries(
    await command(
      "baseline-package-pack",
      ["pack", exactBaseline, "--ignore-scripts", "--dry-run", "--json"],
      { binary: "npm" },
    ),
  );
  assert.equal(packed.length, 1);
  const artifact = packed[0];
  assert(artifact && typeof artifact === "object");
  assert.equal(artifact.name, "openclaw");
  assert.equal(artifact.version, version);
  assert.equal(artifact.integrity, metadata.dist.integrity);
  saveEvidence({
    baseline: metadata,
    baselineArtifact: {
      name: artifact.name,
      version: artifact.version,
      integrity: artifact.integrity,
    },
    candidate: recoveryFileIdentity(candidate),
    storage: [stateDir, process.env.TMPDIR].map((directory) => {
      const stat = fs.statfsSync(directory);
      return { directory, availableBytes: stat.bavail * stat.bsize };
    }),
    limitations: [
      "RSS is sampled for the command process tree; disk sizes are boundary observations, not peak staging usage.",
      "Recovery originals are not full database backups; no such backup is claimed.",
    ],
  });
}

try {
  switch (process.argv[2]) {
    case "seed": {
      // Artifact directories can be reused by a rerun; never compare with a previous run's history.
      fs.rmSync(evidencePath, { force: true });
      fs.rmSync(metricsPath, { force: true });
      fs.rmSync(path.join(runtimeRoot, "recovery-restore-home"), { recursive: true, force: true });
      const fixture = seedRecoveryFixture(stateDir, recoveryVolumeSpec());
      const preDoctorPaths = Object.keys(recoveryTreeSnapshot([stateDir])).filter((file) =>
        file.includes(".pre-doctor-"),
      );
      writeRecoveryJson(fixturePath, { ...fixture, preDoctorPaths });
      break;
    }
    case "packages":
      await packageEvidence();
      break;
    case "migrated": {
      const fixture = readRecoveryJson(fixturePath);
      // Historical updater exit 1 can mean recoverable consent, but cannot excuse a sampler failure.
      assert(
        !fs
          .readFileSync(path.join(artifactRoot, "recovery-update-metrics.log"), "utf8")
          .includes("plugin lifecycle resource ceiling exceeded:"),
        "updater exceeded the existing resource ceiling",
      );
      const originals = assertRecoveryOriginals(fixture, readRecoveryMoves(stateDir));
      const files = Object.keys(recoveryTreeSnapshot([stateDir]));
      const known = new Set(fixture.preDoctorPaths);
      assert(
        !files.some((file) => file.includes(".pre-doctor-") && !known.has(file)),
        "public migration created an extra raw pre-Doctor copy",
      );
      const destinations = [...new Set(readRecoveryMoves(stateDir).map((move) => move.sqlitePath))];
      saveEvidence({
        originals,
        spec: fixture.spec,
        migrationBeforeStandaloneDoctor: true,
        destinations: destinations.map((file) => ({ file, bytes: fs.statSync(file).size })),
      });
      break;
    }
    case "custom-restore":
      await customRestore();
      break;
    case "live":
      await live();
      break;
    case "offline":
      await offline();
      break;
    case "restarted": {
      await proveHistory("restarted", false);
      const evidence = readRecoveryJson(evidencePath);
      assert.equal(evidence.restarted.sqliteEntries, evidence.offline.sqliteEntries);
      for (const original of evidence.originals.filter(
        (item) => item.disposition !== "candidate",
      )) {
        assert.deepEqual(
          recoveryFileIdentity(original.archive),
          original.identity,
          "restart changed protected original",
        );
      }
      assert.deepEqual(
        recoveryFileIdentity(evidence.offline.recreated),
        evidence.offline.recreatedIdentity,
      );
      saveEvidence({ status: "passed", resources: fs.readFileSync(metricsPath, "utf8") });
      break;
    }
    default:
      throw new Error("unknown recovery proof phase");
  }
} catch (error) {
  console.error(error);
  console.error("[upgrade-survivor-recovery] FAILED (exit 1)");
  process.exitCode = 1;
}
