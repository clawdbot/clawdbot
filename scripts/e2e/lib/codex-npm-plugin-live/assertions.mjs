// Assertions for Codex npm plugin live E2E scenarios.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractAgentReplyTexts } from "../agent-turn-output.mjs";
import {
  assertPathInside,
  configPath,
  findPackageJson,
  managedNpmRoot,
  npmProjectRootForInstalledPackage,
  readInstallRecords,
  readJson,
  realPathMaybe,
  stateDir,
} from "../codex-install-utils.mjs";

const command = process.argv[2];
const allowBetaCompatDiagnostics =
  process.env.OPENCLAW_CODEX_NPM_PLUGIN_ALLOW_BETA_COMPAT_DIAGNOSTICS === "1";
const sessionStoreContract =
  process.env.OPENCLAW_CODEX_NPM_PLUGIN_SESSION_STORE_CONTRACT || "sqlite";
const bindingStoreContract =
  process.env.OPENCLAW_CODEX_NPM_PLUGIN_BINDING_STORE_CONTRACT || "plugin-kv";
const MAX_TEXT_FILE_BYTES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TEXT_FILE_BYTES",
  1024 * 1024,
);
const MAX_ERROR_TAIL_BYTES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_ERROR_TAIL_BYTES",
  64 * 1024,
);
const MAX_TRANSCRIPT_FILES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_FILES",
  64,
);
const MAX_TRANSCRIPT_WALK_ENTRIES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_WALK_ENTRIES",
  4096,
);
const MAX_TRANSCRIPT_SCAN_BYTES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_SCAN_BYTES",
  2 * 1024 * 1024,
);
const AGENT_TURN_TIMEOUT_SECONDS = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS",
  420,
);
const CODEX_BINDING_NAMESPACE = "app-server-thread-bindings";

function readPositiveIntEnv(name, fallback) {
  const text = String(process.env[name] ?? fallback).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a positive integer; got: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${text}`);
  }
  return value;
}

function readTextFileBounded(filePath, label, maxBytes = MAX_TEXT_FILE_BYTES) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function readTextFileTail(filePath, label, maxBytes = MAX_ERROR_TAIL_BYTES) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(filePath, "utf8");
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
    return `[${label} truncated to last ${maxBytes} bytes]\n${buffer.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

function readCodexBinding(sessionId, sessionKey, entry) {
  if (bindingStoreContract === "legacy-sidecar") {
    const sessionFile = typeof entry?.sessionFile === "string" ? entry.sessionFile : "";
    if (!sessionFile) {
      throw new Error(`missing legacy Codex session file for ${sessionId}`);
    }
    const bindingPath = `${sessionFile}.codex-app-server.json`;
    const binding = readJson(bindingPath);
    if (![1, 2].includes(binding.schemaVersion) || typeof binding.threadId !== "string") {
      throw new Error(`invalid legacy Codex app-server binding: ${JSON.stringify(binding)}`);
    }
    return binding;
  }
  if (bindingStoreContract !== "plugin-kv") {
    throw new Error(
      `OPENCLAW_CODEX_NPM_PLUGIN_BINDING_STORE_CONTRACT must be plugin-kv or legacy-sidecar; got ${bindingStoreContract}`,
    );
  }

  const dbPath = path.join(stateDir(), "state", "openclaw.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`missing OpenClaw state database: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stableSessionKey = String(sessionKey ?? "").trim();
    const key = stableSessionKey
      ? `session-key:main:${createHash("sha256").update(stableSessionKey).digest("base64url")}`
      : `session:main:${sessionId}`;
    const row = db
      .prepare(
        `SELECT value_json
           FROM plugin_state_entries
          WHERE plugin_id = ? AND namespace = ? AND entry_key = ?
            AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get("codex", CODEX_BINDING_NAMESPACE, key, Date.now());
    if (!row || typeof row.value_json !== "string") {
      throw new Error(`missing Codex app-server binding row: ${key}`);
    }
    const stored = JSON.parse(row.value_json);
    if (stored?.version !== 1 || stored.state !== "active" || !stored.binding) {
      throw new Error(`invalid Codex app-server binding row ${key}: ${row.value_json}`);
    }
    if (stored.sessionId && stored.sessionId !== sessionId) {
      throw new Error(
        `Codex app-server binding row ${key} belongs to session ${stored.sessionId}, expected ${sessionId}`,
      );
    }
    return stored.binding;
  } finally {
    db.close();
  }
}

function readLegacySessionEntry(sessionId) {
  const storePath = path.join(stateDir(), "agents", "main", "sessions", "sessions.json");
  const store = readJson(storePath);
  const sessionMatch = Object.entries(store).find(
    ([, candidate]) => candidate?.sessionId === sessionId,
  );
  if (!sessionMatch) {
    throw new Error(`missing session store entry for ${sessionId}: ${JSON.stringify(store)}`);
  }
  const [sessionKey, entry] = sessionMatch;
  if (typeof entry.sessionFile !== "string" || !fs.existsSync(entry.sessionFile)) {
    throw new Error(`missing OpenClaw session file: ${entry.sessionFile}`);
  }
  const transcriptLines = readTextFileBounded(
    entry.sessionFile,
    "OpenClaw legacy session transcript",
    Math.min(MAX_TEXT_FILE_BYTES, MAX_TRANSCRIPT_SCAN_BYTES),
  )
    .split("\n")
    .filter((line) => line.trim());
  if (transcriptLines.length > MAX_TRANSCRIPT_WALK_ENTRIES) {
    throw new Error(
      `OpenClaw transcript exceeded ${MAX_TRANSCRIPT_WALK_ENTRIES} events for ${sessionId}`,
    );
  }
  const transcriptEvents = transcriptLines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`invalid OpenClaw legacy transcript event ${index + 1} for ${sessionId}`);
    }
  });
  return {
    entry,
    sessionKey,
    transcriptEventCount: transcriptEvents.length,
    transcriptEvents,
  };
}

function readSessionEntry(sessionId) {
  if (sessionStoreContract === "legacy-json") {
    return readLegacySessionEntry(sessionId);
  }
  if (sessionStoreContract !== "sqlite") {
    throw new Error(
      `OPENCLAW_CODEX_NPM_PLUGIN_SESSION_STORE_CONTRACT must be sqlite or legacy-json; got ${sessionStoreContract}`,
    );
  }
  const dbPath = path.join(stateDir(), "agents", "main", "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`missing agent session database: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Keep the aggregate check and row materialization on one SQLite snapshot.
    // The release runner never loads transcript JSON until SQL proves the whole set is bounded.
    db.exec("BEGIN");
    try {
      const row = db
        .prepare(
          `SELECT se.session_key, se.entry_json, s.agent_harness_id
             FROM sessions AS s
             INNER JOIN session_entries AS se ON se.session_id = s.session_id
            WHERE s.session_id = ?
            ORDER BY se.updated_at DESC, se.session_key
            LIMIT 1`,
        )
        .get(sessionId);
      if (!row || typeof row.session_key !== "string" || typeof row.entry_json !== "string") {
        throw new Error(`missing session store entry for ${sessionId}`);
      }
      const transcriptSummary = db
        .prepare(
          `SELECT COUNT(*) AS event_count,
                  COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) AS transcript_bytes
             FROM transcript_events
            WHERE session_id = ?`,
        )
        .get(sessionId);
      if (
        !transcriptSummary ||
        !Number.isSafeInteger(transcriptSummary.event_count) ||
        !Number.isSafeInteger(transcriptSummary.transcript_bytes)
      ) {
        throw new Error(`invalid OpenClaw transcript summary for ${sessionId}`);
      }
      if (transcriptSummary.event_count > MAX_TRANSCRIPT_WALK_ENTRIES) {
        throw new Error(
          `OpenClaw transcript exceeded ${MAX_TRANSCRIPT_WALK_ENTRIES} events for ${sessionId}`,
        );
      }
      if (transcriptSummary.transcript_bytes > MAX_TRANSCRIPT_SCAN_BYTES) {
        throw new Error(
          `OpenClaw transcript exceeded ${MAX_TRANSCRIPT_SCAN_BYTES} bytes for ${sessionId}`,
        );
      }
      const transcriptRows = db
        .prepare(
          `SELECT event_json
             FROM transcript_events
            WHERE session_id = ?
            ORDER BY seq`,
        )
        .all(sessionId);
      let transcriptBytes = 0;
      const transcriptEvents = transcriptRows.map((transcriptRow) => {
        if (typeof transcriptRow.event_json !== "string") {
          throw new Error(`invalid OpenClaw transcript event for ${sessionId}`);
        }
        transcriptBytes += Buffer.byteLength(transcriptRow.event_json);
        if (transcriptBytes > MAX_TRANSCRIPT_SCAN_BYTES) {
          throw new Error(
            `OpenClaw transcript exceeded ${MAX_TRANSCRIPT_SCAN_BYTES} bytes for ${sessionId}`,
          );
        }
        return JSON.parse(transcriptRow.event_json);
      });
      const entry = JSON.parse(row.entry_json);
      return {
        entry: {
          ...entry,
          agentHarnessId:
            typeof row.agent_harness_id === "string" ? row.agent_harness_id : entry.agentHarnessId,
          sessionId,
        },
        sessionKey: row.session_key,
        transcriptEventCount: transcriptEvents.length,
        transcriptEvents,
      };
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

function configure() {
  const modelRef = process.argv[3] || "openai/gpt-5.4";
  const state = stateDir();
  const cfgPath = configPath();
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
    allow: Array.from(new Set([...(cfg.plugins?.allow || []), "codex"])).toSorted((left, right) =>
      left.localeCompare(right),
    ),
    entries: {
      ...cfg.plugins?.entries,
      codex: {
        ...cfg.plugins?.entries?.codex,
        enabled: true,
        config: {
          ...cfg.plugins?.entries?.codex?.config,
          discovery: { enabled: false },
          appServer: {
            ...cfg.plugins?.entries?.codex?.config?.appServer,
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            requestTimeoutMs: AGENT_TURN_TIMEOUT_SECONDS * 1000,
          },
        },
      },
    },
  };
  cfg.agents = {
    ...cfg.agents,
    defaults: {
      ...cfg.agents?.defaults,
      model: { primary: modelRef, fallbacks: [] },
      models: {
        ...cfg.agents?.defaults?.models,
        [modelRef]: { agentRuntime: { id: "codex" } },
      },
      workspace: path.join(state, "workspace"),
      skipBootstrap: true,
      timeoutSeconds: AGENT_TURN_TIMEOUT_SECONDS,
    },
  };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

function readInstallRecord() {
  const record = readInstallRecords().codex;
  if (!record) {
    throw new Error("missing codex install record");
  }
  return record;
}

function normalizePluginSpec(spec) {
  if (spec.startsWith("npm:")) {
    return {
      expectedSpec: spec.slice("npm:".length),
      source: "npm",
    };
  }
  if (spec.startsWith("npm-pack:")) {
    return {
      artifactKind: "npm-pack",
      source: "npm",
      sourcePath: spec.slice("npm-pack:".length),
    };
  }
  if (spec.startsWith("git:")) {
    return {
      expectedSpec: spec,
      source: "git",
    };
  }
  return {
    expectedSpec: spec,
    source: "npm",
  };
}

function assertPlugin() {
  const spec = process.argv[3] || "npm:@openclaw/codex";
  const list = readJson("/tmp/openclaw-codex-plugins-list.json");
  const inspect = readJson("/tmp/openclaw-codex-plugin-inspect.json");
  const plugin = (list.plugins || []).find((entry) => entry.id === "codex");
  if (!plugin) {
    throw new Error("codex plugin not found in plugins list --json output");
  }
  if (plugin.status !== "loaded" || plugin.enabled !== true) {
    throw new Error(
      `expected codex to be enabled+loaded, got enabled=${plugin.enabled} status=${plugin.status}`,
    );
  }
  if (inspect.plugin?.id !== "codex" || inspect.plugin?.status !== "loaded") {
    throw new Error(`unexpected inspect plugin state: ${JSON.stringify(inspect.plugin)}`);
  }
  const hasCodexHarness =
    (Array.isArray(inspect.plugin?.agentHarnessIds) &&
      inspect.plugin.agentHarnessIds.includes("codex")) ||
    (Array.isArray(inspect.capabilities) &&
      inspect.capabilities.some(
        (entry) => entry?.kind === "agent-harness" && entry.ids?.includes("codex"),
      ));
  if (!hasCodexHarness) {
    throw new Error(`codex harness was not registered: ${JSON.stringify(inspect.plugin)}`);
  }
  const diagnostics = [...(list.diagnostics || []), ...(inspect.diagnostics || [])];
  const errors = diagnostics
    .filter((diag) => diag?.level === "error")
    .map((diag) => String(diag.message || ""));
  const unexpectedErrors = allowBetaCompatDiagnostics
    ? errors.filter(
        (message) => message !== "only bundled plugins can claim reserved command ownership: codex",
      )
    : errors;
  if (unexpectedErrors.length > 0) {
    throw new Error(`unexpected plugin diagnostics errors: ${unexpectedErrors.join("; ")}`);
  }

  const record = readInstallRecord();
  const expected = normalizePluginSpec(spec);
  if (record.source !== expected.source) {
    throw new Error(
      `expected codex ${expected.source} install record, got source=${record.source}`,
    );
  }
  if (expected.expectedSpec && record.spec !== expected.expectedSpec) {
    throw new Error(`expected codex install spec ${expected.expectedSpec}, got ${record.spec}`);
  }
  if (expected.artifactKind && record.artifactKind !== expected.artifactKind) {
    throw new Error(
      `expected codex artifact kind ${expected.artifactKind}, got ${record.artifactKind}`,
    );
  }
  if (
    expected.sourcePath &&
    realPathMaybe(record.sourcePath || "") !== realPathMaybe(expected.sourcePath)
  ) {
    throw new Error(`expected codex source path ${expected.sourcePath}, got ${record.sourcePath}`);
  }
  if (record.source === "npm" && (!record.resolvedVersion || !record.resolvedSpec)) {
    throw new Error(`missing codex npm resolution metadata: ${JSON.stringify(record)}`);
  }
  if (record.source === "git" && !record.gitCommit) {
    throw new Error(`missing codex git resolution metadata: ${JSON.stringify(record)}`);
  }
}

function codexInstallPath() {
  const record = readInstallRecord();
  if (typeof record.installPath !== "string" || record.installPath.length === 0) {
    throw new Error(`missing codex installPath: ${JSON.stringify(record)}`);
  }
  return record.installPath.replace(/^~(?=$|\/)/u, process.env.HOME);
}

function codexNpmProjectRoot() {
  return npmProjectRootForInstalledPackage(codexInstallPath(), "@openclaw/codex");
}

function findCodexPackageJson(packageName) {
  const projectRoot = codexNpmProjectRoot();
  return findPackageJson(packageName, [projectRoot, codexInstallPath(), managedNpmRoot()]);
}

function assertNpmDeps() {
  const npmRoot = managedNpmRoot();
  const installPath = codexInstallPath();
  const pluginPackageJson = path.join(installPath, "package.json");
  if (!fs.existsSync(pluginPackageJson)) {
    throw new Error(`missing npm-installed @openclaw/codex package.json: ${pluginPackageJson}`);
  }
  assertPathInside(npmRoot, installPath, "codex plugin install path");
  assertPathInside(npmRoot, pluginPackageJson, "codex plugin package");

  const pluginPackage = readJson(pluginPackageJson);
  if (pluginPackage.name !== "@openclaw/codex") {
    throw new Error(`unexpected codex package name: ${pluginPackage.name}`);
  }

  const openAiCodexPackageJson = findCodexPackageJson("@openai/codex");
  if (!openAiCodexPackageJson) {
    throw new Error("missing @openai/codex dependency under .openclaw/npm");
  }
  assertPathInside(npmRoot, openAiCodexPackageJson, "@openai/codex dependency");

  const bin = resolveCodexBin();
  if (!fs.existsSync(bin)) {
    throw new Error(`missing managed Codex binary: ${bin}`);
  }
  assertPathInside(npmRoot, bin, "managed Codex binary");
}

function resolveCodexBin() {
  const commandName = process.platform === "win32" ? "codex.cmd" : "codex";
  const candidates = [
    path.join(codexNpmProjectRoot(), "node_modules", ".bin", commandName),
    path.join(codexInstallPath(), "node_modules", ".bin", commandName),
    path.join(managedNpmRoot(), "node_modules", ".bin", commandName),
  ];
  const candidate = candidates.find((entry) => fs.existsSync(entry));
  if (candidate) {
    return candidate;
  }
  const packageJson = findCodexPackageJson("@openai/codex");
  if (!packageJson) {
    throw new Error("cannot resolve Codex binary without @openai/codex package");
  }
  const packageRoot = path.dirname(packageJson);
  const pkg = readJson(packageJson);
  const binPath =
    typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin && typeof pkg.bin.codex === "string"
        ? pkg.bin.codex
        : undefined;
  if (!binPath) {
    throw new Error(`@openai/codex package has no codex bin: ${packageJson}`);
  }
  return path.resolve(packageRoot, binPath);
}

function printCodexBin() {
  assertNpmDeps();
  process.stdout.write(`${resolveCodexBin()}\n`);
}

function assertPreflight() {
  const marker = process.argv[3];
  const output = readTextFileBounded("/tmp/openclaw-codex-preflight.log", "Codex preflight log");
  if (!output.includes(marker)) {
    throw new Error(`Codex CLI preflight did not contain ${marker}:\n${output}`);
  }
}

function listFilesRecursive(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_TRANSCRIPT_WALK_ENTRIES) {
        throw new Error(
          `native Codex session transcript walk exceeded ${MAX_TRANSCRIPT_WALK_ENTRIES} entries under ${root}`,
        );
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function assertNativeCodexSessionEvidence(params) {
  const roots = params.roots.filter((root) => fs.existsSync(root));
  const files = roots
    .flatMap((root) => listFilesRecursive(root).filter((filePath) => filePath.endsWith(".jsonl")))
    .map((filePath) => ({ filePath, stat: fs.statSync(filePath) }))
    .toSorted((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    .slice(0, MAX_TRANSCRIPT_FILES);
  if (files.length === 0) {
    throw new Error(
      `missing native Codex session transcript files; checked ${params.roots.join(", ")}`,
    );
  }
  let scannedBytes = 0;
  let matchingEvidence;
  for (const { filePath, stat } of files) {
    const readableBytes = Math.min(stat.size, MAX_TEXT_FILE_BYTES);
    if (scannedBytes + readableBytes > MAX_TRANSCRIPT_SCAN_BYTES) {
      continue;
    }
    scannedBytes += readableBytes;
    const content = readTextFileTail(filePath, "native Codex session transcript", readableBytes);
    if (content.includes(params.marker) || content.includes(params.threadId)) {
      matchingEvidence = { content, filePath };
      break;
    }
  }
  if (!matchingEvidence) {
    throw new Error(
      `native Codex session transcripts did not contain ${params.marker} or ${params.threadId}; scanned ${scannedBytes} bytes across ${files.length} newest files: ${files.map((entry) => entry.filePath).join(", ")}`,
    );
  }
  assertPathInside(params.codexHome, matchingEvidence.filePath, "native Codex session transcript");
  return matchingEvidence;
}

function extractOpenClawToolTimeline(transcriptEvents) {
  const timeline = [];
  for (const event of transcriptEvents) {
    const message = event?.type === "message" ? event.message : undefined;
    if (!message || typeof message !== "object") {
      continue;
    }
    if (message.role === "user") {
      timeline.push({ type: "turn-start", index: timeline.length });
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (
          item?.type === "toolCall" &&
          typeof item.id === "string" &&
          typeof item.name === "string"
        ) {
          timeline.push({
            type: "call",
            id: item.id,
            name: item.name,
            args: item.arguments ?? item.input,
            index: timeline.length,
          });
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      timeline.push({
        type: "result",
        id: message.toolCallId,
        name: typeof message.toolName === "string" ? message.toolName : undefined,
        isError: message.isError === true,
        index: timeline.length,
      });
    }
  }
  return timeline;
}

function findSuccessfulToolResult(timeline, call, beforeIndex = Number.POSITIVE_INFINITY) {
  return timeline.find(
    (entry) =>
      entry.type === "result" &&
      entry.id === call.id &&
      entry.index > call.index &&
      entry.index < beforeIndex &&
      entry.isError !== true,
  );
}

function findToolResult(timeline, call, beforeIndex = Number.POSITIVE_INFINITY) {
  return timeline.find(
    (entry) =>
      entry.type === "result" &&
      entry.id === call.id &&
      entry.index > call.index &&
      entry.index < beforeIndex,
  );
}

function assertFollowthroughTranscript({ transcriptEvents, progressMarker, completeMarker }) {
  const timeline = extractOpenClawToolTimeline(transcriptEvents);
  const markerCalls = timeline.flatMap((entry) => {
    if (entry.type !== "call" || entry.name !== "message") {
      return [];
    }
    const args = entry.args;
    if (!args || typeof args !== "object") {
      return [];
    }
    const text = [args.message, args.text, args.body, args.content].find(
      (value) => typeof value === "string",
    );
    return text === progressMarker || text === completeMarker ? [{ ...entry, args, text }] : [];
  });
  const expected = [
    { text: progressMarker, final: undefined },
    { text: completeMarker, final: true },
  ];
  if (
    markerCalls.length !== expected.length ||
    markerCalls.some(
      (call, index) =>
        call.text !== expected[index].text ||
        call.args.action !== "send" ||
        call.args.final !== expected[index].final,
    )
  ) {
    throw new Error(
      `expected exact message final controls ${JSON.stringify(expected)}, got ${JSON.stringify(markerCalls.map((call) => ({ text: call.text, action: call.args.action, final: call.args.final })))}`,
    );
  }
  const [progressCall, completeCall] = markerCalls;
  const progressResult = findSuccessfulToolResult(timeline, progressCall, completeCall.index);
  if (!progressResult) {
    throw new Error("missing successful progress message result before completion");
  }
  const completeResult = findSuccessfulToolResult(timeline, completeCall);
  if (!completeResult) {
    throw new Error("missing successful completion message result");
  }

  let turnStartIndex = -1;
  for (const entry of timeline) {
    if (entry.type === "turn-start" && entry.index < progressCall.index) {
      turnStartIndex = entry.index;
    }
  }
  const prematureCalls = timeline.filter(
    (entry) =>
      entry.type === "call" &&
      entry.id !== progressCall.id &&
      entry.index > turnStartIndex &&
      entry.index < progressResult.index,
  );
  if (prematureCalls.length > 0) {
    throw new Error(
      `expected progress to be the first completed tool call in its turn; premature calls: ${prematureCalls.map((entry) => entry.name).join(", ")}`,
    );
  }

  const workCalls = timeline.filter(
    (entry) =>
      entry.type === "call" &&
      entry.name !== "message" &&
      entry.index > progressResult.index &&
      entry.index < completeCall.index,
  );
  if (workCalls.length === 0) {
    throw new Error("expected successful workspace work between progress and completion");
  }
  const successfulWorkCalls = workCalls.filter((entry) =>
    findSuccessfulToolResult(timeline, entry, completeCall.index),
  );
  if (successfulWorkCalls.length === 0) {
    throw new Error("expected successful workspace work between progress and completion");
  }
  const unsettledWorkCalls = workCalls.filter(
    (entry) => !findToolResult(timeline, entry, completeCall.index),
  );
  if (unsettledWorkCalls.length > 0) {
    throw new Error(
      `expected all workspace work to settle before completion; unsettled calls: ${unsettledWorkCalls.map((entry) => entry.name).join(", ")}`,
    );
  }

  const nextTurnStart = timeline.find(
    (entry) => entry.type === "turn-start" && entry.index > completeResult.index,
  );
  const postCompletionWorkCalls = timeline.filter(
    (entry) =>
      entry.type === "call" &&
      entry.name !== "message" &&
      entry.index > completeCall.index &&
      entry.index < (nextTurnStart?.index ?? Number.POSITIVE_INFINITY),
  );
  if (postCompletionWorkCalls.length > 0) {
    throw new Error(
      `unexpected workspace work after completion: ${postCompletionWorkCalls.map((entry) => entry.name).join(", ")}`,
    );
  }
}

function assertAgentTurnEvidence({ marker, sessionId, modelRef, stdoutPath, stderrPath }) {
  const stdout = readTextFileBounded(stdoutPath, "OpenClaw agent JSON");
  const stderr = readTextFileTail(stderrPath, "OpenClaw agent stderr");
  const response = JSON.parse(stdout);
  const text = extractAgentReplyTexts(JSON.stringify(response)).join("\n");
  if (!text.includes(marker)) {
    throw new Error(
      `OpenClaw agent reply did not contain ${marker}:\nstdout=${stdout}\nstderr=${stderr}`,
    );
  }
  const expectedProvider = modelRef.split("/")[0] || "codex";
  const executionTrace = response.meta?.executionTrace;
  if (!executionTrace || executionTrace.winnerProvider !== expectedProvider) {
    throw new Error(
      `expected Codex plugin model provider ${expectedProvider} to win the agent turn, got ${JSON.stringify(executionTrace)}`,
    );
  }

  const { entry, sessionKey, transcriptEventCount, transcriptEvents } = readSessionEntry(sessionId);
  if (entry.agentHarnessId !== "codex") {
    throw new Error(`expected codex harness in session entry, got ${entry.agentHarnessId}`);
  }
  if (entry.modelOverride && entry.modelOverride !== modelRef) {
    throw new Error(`unexpected session model override: ${entry.modelOverride}`);
  }
  if (!Number.isSafeInteger(transcriptEventCount) || transcriptEventCount < 1) {
    throw new Error(`missing OpenClaw transcript events for ${sessionId}`);
  }

  const binding = readCodexBinding(sessionId, sessionKey, entry);
  if (typeof binding.threadId !== "string") {
    throw new Error(`invalid Codex app-server binding: ${JSON.stringify(binding)}`);
  }
  if (binding.model !== modelRef.split("/").slice(1).join("/")) {
    throw new Error(`unexpected Codex binding model: ${binding.model}`);
  }
  if (binding.modelProvider && !["codex", "openai"].includes(binding.modelProvider)) {
    throw new Error(`unexpected Codex binding provider: ${binding.modelProvider}`);
  }

  const agentDir = path.join(stateDir(), "agents", "main");
  const codexHomes = [
    path.join(agentDir, "codex-home"),
    path.join(agentDir, "agent", "codex-home"),
    path.join(path.dirname(agentDir), "codex-home"),
  ].filter((entryValue, index, entries) => entries.indexOf(entryValue) === index);
  const codexHome = codexHomes.find((entryLocal) => fs.existsSync(entryLocal));
  if (!codexHome) {
    throw new Error(`missing isolated Codex home; checked ${codexHomes.join(", ")}`);
  }
  const codexSessionRoot = path.join(codexHome, "sessions");
  const nativeSessionRoot = path.join(codexHome, "home", ".codex", "sessions");
  const nativeSessionEvidence = assertNativeCodexSessionEvidence({
    codexHome,
    marker,
    roots: [codexSessionRoot, nativeSessionRoot],
    threadId: binding.threadId,
  });
  return { nativeSessionEvidence, transcriptEvents };
}

function assertAgentTurn() {
  assertAgentTurnEvidence({
    marker: process.argv[3],
    sessionId: process.argv[4],
    modelRef: process.argv[5],
    stdoutPath: "/tmp/openclaw-codex-agent.json",
    stderrPath: "/tmp/openclaw-codex-agent.err",
  });
}

function assertFollowthrough() {
  const progressMarker = process.argv[3];
  const completeMarker = process.argv[4];
  const sessionId = process.argv[5];
  const modelRef = process.argv[6];
  const artifactPath = process.argv[7];
  const inputPaths = process.argv.slice(8);
  if (inputPaths.length !== 3) {
    throw new Error(`expected three follow-through input paths, got ${inputPaths.length}`);
  }

  const stdoutPath = "/tmp/openclaw-codex-followthrough.json";
  const stderrPath = "/tmp/openclaw-codex-followthrough.err";
  const response = JSON.parse(readTextFileBounded(stdoutPath, "OpenClaw follow-through JSON"));
  const replyTexts = (response.payloads || [])
    .map((payload) => (payload && typeof payload.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean);
  const expectedReplies = [progressMarker, completeMarker];
  if (JSON.stringify(replyTexts) !== JSON.stringify(expectedReplies)) {
    throw new Error(
      `expected exact progress and completion replies ${JSON.stringify(expectedReplies)}, got ${JSON.stringify(replyTexts)}`,
    );
  }

  const expectedArtifact = `${inputPaths
    .map((inputPath, index) =>
      readTextFileBounded(inputPath, `follow-through input ${index + 1}`).trim(),
    )
    .join("\n")}\n`;
  const artifact = readTextFileBounded(artifactPath, "Codex follow-through artifact");
  if (artifact !== expectedArtifact) {
    throw new Error(
      `unexpected Codex follow-through artifact; expected ${JSON.stringify(expectedArtifact)}, got ${JSON.stringify(artifact)}`,
    );
  }

  const evidence = assertAgentTurnEvidence({
    marker: completeMarker,
    sessionId,
    modelRef,
    stdoutPath,
    stderrPath,
  });
  assertFollowthroughTranscript({
    transcriptEvents: evidence.transcriptEvents,
    progressMarker,
    completeMarker,
  });
}

function assertUninstalled() {
  const records = readInstallRecords();
  if (records.codex) {
    throw new Error(
      `codex install record still exists after uninstall: ${JSON.stringify(records.codex)}`,
    );
  }
  const list = readJson("/tmp/openclaw-codex-plugins-list-after-uninstall.json");
  const plugin = (list.plugins || []).find((entry) => entry.id === "codex");
  if (plugin?.status === "loaded" || plugin?.enabled === true) {
    throw new Error(`codex plugin still loaded/enabled after uninstall: ${JSON.stringify(plugin)}`);
  }
  const diagnostics = list.diagnostics || [];
  const errors = diagnostics
    .filter((diag) => diag?.level === "error")
    .map((diag) => String(diag.message || ""));
  if (errors.length > 0) {
    throw new Error(`unexpected plugin diagnostics errors after uninstall: ${errors.join("; ")}`);
  }
}

function assertAgentError() {
  const status = Number(process.argv[3]);
  if (!Number.isInteger(status) || status === 0) {
    throw new Error(
      `expected OpenClaw agent to fail after Codex uninstall, got status ${process.argv[3]}`,
    );
  }
  const stdout = fs.existsSync("/tmp/openclaw-codex-agent-after-uninstall.json")
    ? readTextFileTail(
        "/tmp/openclaw-codex-agent-after-uninstall.json",
        "post-uninstall agent stdout",
      )
    : "";
  const stderr = fs.existsSync("/tmp/openclaw-codex-agent-after-uninstall.err")
    ? readTextFileTail(
        "/tmp/openclaw-codex-agent-after-uninstall.err",
        "post-uninstall agent stderr",
      )
    : "";
  const combined = `${stdout}\n${stderr}`;
  if (
    !combined.includes('Requested agent harness "codex" is not registered') &&
    !combined.includes("Unknown model: codex/")
  ) {
    throw new Error(`unexpected post-uninstall agent error:\nstdout=${stdout}\nstderr=${stderr}`);
  }
}

const commands = {
  configure,
  "assert-plugin": assertPlugin,
  "assert-npm-deps": assertNpmDeps,
  "print-codex-bin": printCodexBin,
  "assert-preflight": assertPreflight,
  "assert-agent-turn": assertAgentTurn,
  "assert-followthrough": assertFollowthrough,
  "assert-uninstalled": assertUninstalled,
  "assert-agent-error": assertAgentError,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown codex npm plugin live assertion command: ${command}`);
}
fn();
