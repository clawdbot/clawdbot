// Assertions for kitchen-sink plugin E2E scenarios.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";

const command = process.argv[2];
const scratchRoot = process.env.KITCHEN_SINK_TMP_DIR || os.tmpdir();

const LOG_SCAN_CHUNK_BYTES = 64 * 1024;
const LOG_SCAN_FINDING_CONTEXT_CHARS = 2048;
const LOG_SCAN_MAX_ENTRIES = readPositiveIntEnv("KITCHEN_SINK_LOG_SCAN_MAX_ENTRIES", 20_000);
const LOG_SCAN_MAX_FILES = 5000;
const LOG_SCAN_MAX_FINDINGS = 100;
const LOG_SCAN_MAX_LINE_CHARS = 16 * 1024;
const LOG_SCAN_SEGMENT_OVERLAP_CHARS = 256;
const EXPECT_FAILURE_OUTPUT_MAX_BYTES = readPositiveIntEnv(
  "KITCHEN_SINK_EXPECT_FAILURE_OUTPUT_MAX_BYTES",
  1024 * 1024,
);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const scratchFile = (name) => path.join(scratchRoot, name);
const normalizedPath = (filePath) => filePath.replaceAll("\\", "/");

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  return parsed;
}

function resolveHomePath(value) {
  if (value === "~") {
    return process.env.HOME;
  }
  if (value?.startsWith("~/") || value?.startsWith("~\\")) {
    return path.join(process.env.HOME, value.slice(2));
  }
  return value;
}

function readTextFileBounded(file, maxBytes, label) {
  const stats = fs.statSync(file);
  if (stats.size > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes: ${file} (${stats.size} bytes)`);
  }
  return fs.readFileSync(file, "utf8");
}

function expectFailure() {
  const outputFile = process.argv[3];
  const output = readTextFileBounded(
    outputFile,
    EXPECT_FAILURE_OUTPUT_MAX_BYTES,
    "expected failure output",
  );
  const source = process.env.KITCHEN_SINK_SOURCE;
  const spec = process.env.KITCHEN_SINK_SPEC;
  const displayedSpec = source === "npm" ? spec.replace(/^npm:/u, "") : spec;
  const expected =
    source === "clawhub"
      ? /Version not found on ClawHub|ClawHub .* failed \(404\)|version.*not found/iu
      : /No matching version|ETARGET|notarget|npm (?:error|ERR!)/iu;
  if (!output.includes(displayedSpec)) {
    throw new Error(`expected failure output to mention ${displayedSpec}`);
  }
  if (!expected.test(output)) {
    throw new Error(`unexpected ${source} beta failure output:\n${output}`);
  }
}

function scanTextFileLines(file, onLine) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(LOG_SCAN_CHUNK_BYTES);
    let currentLine = "";
    let lineNumber = 1;
    const emitLine = (line, info = {}) => onLine(line, lineNumber, info);
    const appendLineText = (text, complete) => {
      currentLine += text;
      while (currentLine.length > LOG_SCAN_MAX_LINE_CHARS) {
        const segment = currentLine.slice(0, LOG_SCAN_MAX_LINE_CHARS);
        currentLine = currentLine.slice(LOG_SCAN_MAX_LINE_CHARS - LOG_SCAN_SEGMENT_OVERLAP_CHARS);
        if (!emitLine(segment, { truncated: true })) {
          return false;
        }
      }
      if (complete) {
        if (!emitLine(currentLine)) {
          return false;
        }
        currentLine = "";
        lineNumber += 1;
      }
      return true;
    };

    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split(/\r?\n/u);
      for (let index = 0; index < lines.length - 1; index += 1) {
        if (!appendLineText(lines[index], true)) {
          return;
        }
      }
      if (!appendLineText(lines.at(-1) ?? "", false)) {
        return;
      }
    }
    if (currentLine.length > 0) {
      onLine(currentLine, lineNumber);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function formatFindingLine(line, pattern, info = {}) {
  const matchIndex = Math.max(0, line.search(pattern));
  const halfWindow = Math.floor(LOG_SCAN_FINDING_CONTEXT_CHARS / 2);
  const start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(line.length, start + LOG_SCAN_FINDING_CONTEXT_CHARS);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < line.length || info.truncated ? " ..." : "";
  return `${prefix}${line.slice(start, end)}${suffix}`;
}

function shouldScanLogFile(entry) {
  if (!(/\.(?:log|jsonl)$/u.test(entry) || /openclaw-kitchen-sink-/u.test(path.basename(entry)))) {
    return false;
  }
  return !normalizedPath(entry).includes("/.npm/_logs/");
}

function scanLogFiles(roots, onFile) {
  let scannedFiles = 0;
  let visitedEntries = 0;
  for (const root of roots) {
    const pending = [{ entry: root, counted: false }];
    while (pending.length > 0) {
      const pendingEntry = pending.pop();
      const entry = pendingEntry?.entry;
      if (!entry || !fs.existsSync(entry)) {
        continue;
      }
      if (!pendingEntry.counted) {
        visitedEntries += 1;
        if (visitedEntries > LOG_SCAN_MAX_ENTRIES) {
          throw new Error(
            `kitchen-sink log scan exceeded ${LOG_SCAN_MAX_ENTRIES} filesystem entries`,
          );
        }
      }
      const entryType = pendingEntry.dirent ?? fs.lstatSync(entry);
      if (entryType.isSymbolicLink()) {
        continue;
      }
      if (entryType.isDirectory()) {
        const dir = fs.opendirSync(entry);
        try {
          let child;
          while ((child = dir.readSync()) !== null) {
            visitedEntries += 1;
            if (visitedEntries > LOG_SCAN_MAX_ENTRIES) {
              throw new Error(
                `kitchen-sink log scan exceeded ${LOG_SCAN_MAX_ENTRIES} filesystem entries`,
              );
            }
            pending.push({
              counted: true,
              dirent: child,
              entry: path.join(entry, child.name),
            });
          }
        } finally {
          dir.closeSync();
        }
        continue;
      }
      if (!shouldScanLogFile(entry)) {
        continue;
      }
      scannedFiles += 1;
      if (scannedFiles > LOG_SCAN_MAX_FILES) {
        throw new Error(`kitchen-sink log scan exceeded ${LOG_SCAN_MAX_FILES} candidate files`);
      }
      if (!onFile(entry, scannedFiles)) {
        return scannedFiles;
      }
    }
  }
  return scannedFiles;
}

function scanLogs() {
  if (!process.env.KITCHEN_SINK_TMP_DIR) {
    throw new Error("KITCHEN_SINK_TMP_DIR is required for kitchen-sink log scans");
  }
  const roots = [scratchRoot, path.join(process.env.HOME, ".openclaw")];
  const deny = [
    /\buncaught exception\b/iu,
    /\bunhandled rejection\b/iu,
    /\bfatal\b/iu,
    /\bpanic\b/iu,
    /\blevel["']?\s*:\s*["']error["']/iu,
    /\[(?:error|ERROR)\]/u,
  ];
  const allow = [
    /^\s*0 errors?\s*$/iu,
    /^\s*expected no diagnostics errors?\s*$/iu,
    /^\s*diagnostics errors?:\s*$/iu,
  ];
  const findings = [];
  let omittedFindings = false;
  const scannedFiles = scanLogFiles(roots, (file) => {
    scanTextFileLines(file, (line, lineNumber, info) => {
      if (allow.some((pattern) => pattern.test(line))) {
        return true;
      }
      const matchedPattern = deny.find((pattern) => pattern.test(line));
      if (matchedPattern) {
        if (findings.length >= LOG_SCAN_MAX_FINDINGS) {
          omittedFindings = true;
          return false;
        }
        findings.push(`${file}:${lineNumber}: ${formatFindingLine(line, matchedPattern, info)}`);
      }
      return true;
    });
    if (omittedFindings) {
      return false;
    }
    return true;
  });
  if (scannedFiles === 0) {
    throw new Error(
      "kitchen-sink log scan found no files under the isolated scratch root or OpenClaw home",
    );
  }
  if (findings.length > 0) {
    const suffix = omittedFindings ? "\n... additional findings omitted" : "";
    throw new Error(`unexpected error-like log lines:\n${findings.join("\n")}${suffix}`);
  }
  console.log(`log scan passed (${scannedFiles} file(s))`);
}

function readConfig() {
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  return {
    configPath,
    exists: fs.existsSync(configPath),
    config: fs.existsSync(configPath) ? readJson(configPath) : {},
  };
}

function configureRuntime() {
  const pluginId = process.env.KITCHEN_SINK_ID;
  const { configPath, config } = readConfig();
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries[pluginId] = {
    ...config.plugins.entries[pluginId],
    hooks: {
      ...config.plugins.entries[pluginId]?.hooks,
      allowConversationAccess: true,
    },
  };
  config.channels = {
    ...config.channels,
    "kitchen-sink-channel": { enabled: true, token: "kitchen-sink-ci" },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function removeChannelConfig() {
  const { configPath, exists, config } = readConfig();
  if (!exists) {
    return;
  }
  delete config.channels?.["kitchen-sink-channel"];
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

const expectIncludes = (listValue, expected, field) => {
  if (!Array.isArray(listValue) || !listValue.includes(expected)) {
    throw new Error(`${field} missing ${expected}: ${JSON.stringify(listValue)}`);
  }
};
const expectIncludesAny = (listValue, expectedValues, field) => {
  if (
    !Array.isArray(listValue) ||
    !expectedValues.some((expected) => listValue.includes(expected))
  ) {
    throw new Error(
      `${field} missing one of ${expectedValues.join(", ")}: ${JSON.stringify(listValue)}`,
    );
  }
};
const expectMissing = (listValue, expected, field) => {
  if (Array.isArray(listValue) && listValue.includes(expected)) {
    throw new Error(`${field} unexpectedly included ${expected}: ${JSON.stringify(listValue)}`);
  }
};

const INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES = new Set(["full", "conformance", "adversarial"]);
const requiredFullDiagnosticCanaries = new Set([
  "agent tool result middleware must be a function",
  "trusted tool policy registration requires id, description, and evaluate()",
  "plugin must declare contracts.tools for: kitchen-sink-tool",
  'channel "kitchen-sink-channel-probe" registration missing required config helpers',
  'agent harness "kitchen-sink-agent-harness" registration missing required runtime methods',
  "session scheduler job registration requires unique id, sessionKey, and kind",
]);

function assertExpectedDiagnostics(surfaceMode, errorMessages) {
  const expectedErrorMessages = new Set([
    "cli registration missing explicit commands metadata",
    "only bundled plugins can register Codex app-server extension factories",
    "agent tool result middleware must be a function",
    'compaction provider "kitchen-sink-compaction-provider" registration missing summarize',
    "context engine registration missing id",
    "control UI descriptor registration requires id, surface, label, and valid optional fields",
    "hosted media resolver registration missing resolver",
    "http route registration missing or invalid auth: /kitchen-sink/http-route",
    "node invoke policy registration missing commands",
    "trusted tool policy registration requires id, description, and evaluate()",
    "plugin must declare contracts.embeddingProviders for adapter: kitchen-sink-embedding-provider",
    "plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: kitchen-sink-memory-embedding-provider",
    "plugin must declare contracts.tools for: kitchen-sink-tool",
    'channel "kitchen-sink-channel-probe" registration missing required config helpers',
    'agent harness "kitchen-sink-agent-harness" registration missing required runtime methods',
    "memory prompt supplement registration missing builder",
    "model catalog provider registration missing provider",
    "session extension registration requires namespace and description",
    "session scheduler job registration requires unique id, sessionKey, and kind",
    "tool metadata registration missing toolName",
  ]);
  const optionalErrorMessages = new Set([
    "agent event subscription registration requires id and handle",
  ]);
  const allowedErrorMessages = new Set([...expectedErrorMessages, ...optionalErrorMessages]);
  if (!INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES.has(surfaceMode)) {
    if (errorMessages.size > 0) {
      throw new Error(
        `unexpected kitchen-sink diagnostic errors: ${[...errorMessages].join(", ")}`,
      );
    }
    return;
  }
  for (const message of errorMessages) {
    if (!allowedErrorMessages.has(message)) {
      throw new Error(`unexpected kitchen-sink diagnostic error: ${message}`);
    }
  }
  if (surfaceMode === "full") {
    // Default Docker scenarios install the published package, which can lag this repo.
    // Exhaustive matching is reserved for synchronized/current package fixtures.
    const requiredMessages =
      process.env.KITCHEN_SINK_REQUIRE_ALL_DIAGNOSTICS === "1"
        ? expectedErrorMessages
        : requiredFullDiagnosticCanaries;
    for (const message of requiredMessages) {
      if (!errorMessages.has(message)) {
        throw new Error(`missing expected kitchen-sink diagnostic error: ${message}`);
      }
    }
  }
}

function assertRealPathInside(parentPath, childPath, label) {
  const parentRealPath = fs.realpathSync(parentPath);
  const childRealPath = fs.realpathSync(childPath);
  if (
    childRealPath !== parentRealPath &&
    !childRealPath.startsWith(`${parentRealPath}${path.sep}`)
  ) {
    throw new Error(`${label} resolved outside ${parentPath}: ${childRealPath}`);
  }
}

function assertClawHubExternalInstallContract(installPath) {
  const openclawPeerPath = path.join(installPath, "node_modules", "openclaw");
  if (!fs.existsSync(openclawPeerPath)) {
    throw new Error(`missing kitchen-sink openclaw peer symlink: ${openclawPeerPath}`);
  }
  if (!fs.lstatSync(openclawPeerPath).isSymbolicLink()) {
    throw new Error(`kitchen-sink openclaw peer is not a symlink: ${openclawPeerPath}`);
  }
  const hostRoot = fs.realpathSync(process.cwd());
  const linkedHostRoot = fs.realpathSync(openclawPeerPath);
  if (linkedHostRoot !== hostRoot) {
    throw new Error(`expected kitchen-sink openclaw peer ${linkedHostRoot} to target ${hostRoot}`);
  }

  const dependencyPackagePath = path.join(installPath, "node_modules", "is-number", "package.json");
  if (fs.existsSync(dependencyPackagePath)) {
    assertRealPathInside(installPath, dependencyPackagePath, "kitchen-sink isolated dependency");
  }
}

function assertClawHubArtifactMetadata(record) {
  if (record.artifactKind === "legacy-zip") {
    if (record.artifactFormat !== "zip") {
      throw new Error(
        `missing kitchen-sink legacy ZIP artifact metadata: ${JSON.stringify(record)}`,
      );
    }
    return;
  }

  if (record.artifactKind !== "npm-pack" || record.artifactFormat !== "tgz") {
    throw new Error(`missing kitchen-sink ClawHub artifact metadata: ${JSON.stringify(record)}`);
  }
  if (!record.clawpackSha256 || typeof record.clawpackSize !== "number") {
    throw new Error(`missing kitchen-sink ClawPack metadata: ${JSON.stringify(record)}`);
  }
  if (!record.npmIntegrity || !record.npmShasum || !record.npmTarballName) {
    throw new Error(`missing kitchen-sink npm artifact metadata: ${JSON.stringify(record)}`);
  }
}

function inferInstallSource(spec) {
  if (spec?.startsWith("npm:")) {
    return "npm";
  }
  if (spec?.startsWith("clawhub:")) {
    return "clawhub";
  }
  return null;
}

function assertCutoverPreinstalled() {
  const pluginId = process.env.KITCHEN_SINK_ID;
  const preinstallSpec = process.env.KITCHEN_SINK_PREINSTALL_SPEC;
  const source = inferInstallSource(preinstallSpec);
  if (!pluginId || !preinstallSpec || !source) {
    throw new Error(`invalid kitchen-sink cutover preinstall spec: ${preinstallSpec}`);
  }

  const record = readPluginInstallRecords()[pluginId];
  if (!record) {
    throw new Error(`missing kitchen-sink cutover preinstall record for ${pluginId}`);
  }
  if (record.source !== source) {
    throw new Error(`expected kitchen-sink preinstall source=${source}, got ${record.source}`);
  }
  const expectedSpec = source === "npm" ? preinstallSpec.replace(/^npm:/u, "") : preinstallSpec;
  if (record.spec !== expectedSpec) {
    throw new Error(`expected kitchen-sink preinstall spec ${expectedSpec}, got ${record.spec}`);
  }
}

function assertInstalled() {
  const pluginId = process.env.KITCHEN_SINK_ID;
  const spec = process.env.KITCHEN_SINK_SPEC;
  const source = process.env.KITCHEN_SINK_SOURCE;
  const surfaceMode = process.env.KITCHEN_SINK_SURFACE_MODE;
  const label = process.env.KITCHEN_SINK_LABEL;
  const list = readJson(scratchFile(`kitchen-sink-${label}-plugins.json`));
  const inspect = readJson(scratchFile(`kitchen-sink-${label}-inspect.json`));
  const allInspect = readJson(scratchFile(`kitchen-sink-${label}-inspect-all.json`));
  if (!Array.isArray(allInspect)) {
    throw new Error("kitchen-sink inspect --all output was not an array");
  }
  const plugin = (list.plugins || []).find((entry) => entry.id === pluginId);
  if (!plugin) {
    throw new Error(`kitchen-sink plugin not found after install: ${pluginId}`);
  }
  const allInspectPlugin = allInspect.find((entry) => entry?.plugin?.id === pluginId);
  if (!allInspectPlugin) {
    throw new Error(`kitchen-sink plugin missing from inspect --all output: ${pluginId}`);
  }
  if (!allInspectPlugin.plugin?.enabled || allInspectPlugin.plugin?.status !== "loaded") {
    throw new Error(
      `expected enabled loaded kitchen-sink plugin in inspect --all, got enabled=${allInspectPlugin.plugin?.enabled} status=${allInspectPlugin.plugin?.status}`,
    );
  }
  if (plugin.status !== "loaded") {
    throw new Error(`unexpected kitchen-sink status after enable: ${plugin.status}`);
  }
  if (inspect.plugin?.id !== pluginId) {
    throw new Error(`unexpected inspected kitchen-sink plugin id: ${inspect.plugin?.id}`);
  }
  if (!inspect.plugin?.enabled || inspect.plugin?.status !== "loaded") {
    throw new Error(
      `expected enabled loaded kitchen-sink plugin, got enabled=${inspect.plugin?.enabled} status=${inspect.plugin?.status}`,
    );
  }

  if (surfaceMode !== "adversarial") {
    expectIncludes(inspect.plugin?.channelIds, "kitchen-sink-channel", "channels");
    expectIncludes(inspect.plugin?.providerIds, "kitchen-sink-provider", "providers");
  }
  if (source === "clawhub") {
    expectIncludes(inspect.plugin?.contextEngineIds, pluginId, "context engines");
  }

  const diagnostics = [
    ...(list.diagnostics || []),
    ...(inspect.diagnostics || []),
    ...(allInspectPlugin.diagnostics || []),
  ];
  const errorMessages = new Set(
    diagnostics.filter((diag) => diag?.level === "error").map((diag) => String(diag.message || "")),
  );

  if (surfaceMode === "full" || surfaceMode === "conformance") {
    const toolNames = Array.isArray(inspect.tools)
      ? inspect.tools.flatMap((entry) => (Array.isArray(entry?.names) ? entry.names : []))
      : [];
    const pluginSurfaceIds = {
      speechProviderIds: [
        ["kitchen-sink-speech", "kitchen-sink-speech-provider"],
        "speech providers",
      ],
      realtimeTranscriptionProviderIds: [
        ["kitchen-sink-realtime-transcription", "kitchen-sink-realtime-transcription-provider"],
        "realtime transcription providers",
      ],
      realtimeVoiceProviderIds: [
        ["kitchen-sink-realtime-voice", "kitchen-sink-realtime-voice-provider"],
        "realtime voice providers",
      ],
      mediaUnderstandingProviderIds: [
        ["kitchen-sink-media", "kitchen-sink-media-understanding-provider"],
        "media understanding providers",
      ],
      imageGenerationProviderIds: [
        ["kitchen-sink-image", "kitchen-sink-image-generation-provider"],
        "image generation providers",
      ],
      videoGenerationProviderIds: [
        ["kitchen-sink-video", "kitchen-sink-video-generation-provider"],
        "video generation providers",
      ],
      musicGenerationProviderIds: [
        ["kitchen-sink-music", "kitchen-sink-music-generation-provider"],
        "music generation providers",
      ],
      webFetchProviderIds: [
        ["kitchen-sink-fetch", "kitchen-sink-web-fetch-provider"],
        "web fetch providers",
      ],
      webSearchProviderIds: [
        ["kitchen-sink-search", "kitchen-sink-web-search-provider"],
        "web search providers",
      ],
      migrationProviderIds: [
        ["kitchen-sink-migration-providers", "kitchen-sink-migration-provider"],
        "migration providers",
      ],
    };
    for (const [field, [ids, labelLocal]] of Object.entries(pluginSurfaceIds)) {
      expectIncludesAny(inspect.plugin?.[field], ids, labelLocal);
    }
    expectMissing(inspect.plugin?.agentHarnessIds, "kitchen-sink-agent-harness", "agent harnesses");
    expectIncludes(inspect.services, "kitchen-sink-service", "services");
    if (surfaceMode === "full") {
      expectIncludesAny(inspect.commands, ["kitchen", "kitchen-sink-command"], "commands");
      for (const toolName of [
        "kitchen_sink_text",
        "kitchen_sink_search",
        "kitchen_sink_image_job",
      ]) {
        expectIncludes(toolNames, toolName, "tools");
      }
    } else {
      expectIncludes(inspect.commands, "kitchen", "commands");
      expectIncludes(toolNames, "kitchen_sink_text", "tools");
    }
    if (
      (inspect.plugin?.hookCount || 0) < 30 ||
      !Array.isArray(inspect.typedHooks) ||
      inspect.typedHooks.length < 30
    ) {
      throw new Error(
        `expected kitchen-sink typed hooks to load, got hookCount=${inspect.plugin?.hookCount} typedHooks=${inspect.typedHooks?.length}`,
      );
    }
  }
  assertExpectedDiagnostics(surfaceMode, errorMessages);

  const record = readPluginInstallRecords()[pluginId];
  if (!record) {
    throw new Error(`missing kitchen-sink install record for ${pluginId}`);
  }
  if (record.source !== source) {
    throw new Error(`expected kitchen-sink install source=${source}, got ${record.source}`);
  }
  if (source === "npm") {
    const expectedSpec = spec.replace(/^npm:/u, "");
    if (record.spec !== expectedSpec) {
      throw new Error(`expected kitchen-sink npm spec ${expectedSpec}, got ${record.spec}`);
    }
    if (!record.resolvedVersion || !record.resolvedSpec) {
      throw new Error(`missing npm resolution metadata: ${JSON.stringify(record)}`);
    }
  } else if (source === "clawhub") {
    const value = spec.slice("clawhub:".length).trim();
    const slashIndex = value.lastIndexOf("/");
    const atIndex = value.lastIndexOf("@");
    const packageName = atIndex > 0 && atIndex > slashIndex ? value.slice(0, atIndex) : value;
    if (record.spec !== spec) {
      throw new Error(`expected kitchen-sink ClawHub spec ${spec}, got ${record.spec}`);
    }
    if (record.clawhubPackage !== packageName) {
      throw new Error(`expected ClawHub package ${packageName}, got ${record.clawhubPackage}`);
    }
    if (record.clawhubFamily !== "code-plugin" && record.clawhubFamily !== "bundle-plugin") {
      throw new Error(`unexpected ClawHub family: ${record.clawhubFamily}`);
    }
    if (!record.version || !record.integrity || !record.resolvedAt) {
      throw new Error(`missing ClawHub resolution metadata: ${JSON.stringify(record)}`);
    }
    assertClawHubArtifactMetadata(record);
  }
  if (typeof record.installPath !== "string" || record.installPath.length === 0) {
    throw new Error("missing kitchen-sink install path");
  }
  const installPath = resolveHomePath(record.installPath);
  if (!fs.existsSync(installPath)) {
    throw new Error(`kitchen-sink install path missing: ${record.installPath}`);
  }
  if (source === "clawhub") {
    const extensionsRoot = path.join(process.env.HOME, ".openclaw", "extensions");
    assertRealPathInside(extensionsRoot, installPath, "kitchen-sink ClawHub install path");
  }
  if (source === "clawhub" && record.artifactKind === "npm-pack") {
    assertClawHubExternalInstallContract(installPath);
  }
  fs.writeFileSync(scratchFile(`kitchen-sink-${label}-install-path.txt`), installPath, "utf8");
}

function assertRemoved() {
  const pluginId = process.env.KITCHEN_SINK_ID;
  const label = process.env.KITCHEN_SINK_LABEL;
  const list = readJson(scratchFile(`kitchen-sink-${label}-uninstalled.json`));
  if ((list.plugins || []).some((entry) => entry.id === pluginId)) {
    throw new Error(`kitchen-sink plugin still listed after uninstall: ${pluginId}`);
  }

  const records = readPluginInstallRecords();
  if (records[pluginId]) {
    throw new Error(`kitchen-sink install record still present after uninstall: ${pluginId}`);
  }

  const { config } = readConfig();
  if (config.plugins?.entries?.[pluginId]) {
    throw new Error(`kitchen-sink config entry still present after uninstall: ${pluginId}`);
  }
  if ((config.plugins?.allow || []).includes(pluginId)) {
    throw new Error(`kitchen-sink allowlist still contains ${pluginId}`);
  }
  if ((config.plugins?.deny || []).includes(pluginId)) {
    throw new Error(`kitchen-sink denylist still contains ${pluginId}`);
  }
  if (config.channels?.["kitchen-sink-channel"]) {
    throw new Error("kitchen-sink channel config still present after uninstall");
  }
  const installPathFile = scratchFile(`kitchen-sink-${label}-install-path.txt`);
  if (fs.existsSync(installPathFile)) {
    const installPath = fs.readFileSync(installPathFile, "utf8").trim();
    if (installPath && fs.existsSync(installPath)) {
      throw new Error(`kitchen-sink managed install directory still exists: ${installPath}`);
    }
  }
}

const commands = {
  "expect-failure": expectFailure,
  "scan-logs": scanLogs,
  "configure-runtime": configureRuntime,
  "remove-channel-config": removeChannelConfig,
  "assert-cutover-preinstalled": assertCutoverPreinstalled,
  "assert-installed": assertInstalled,
  "assert-removed": assertRemoved,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown kitchen-sink assertion command: ${command}`);
}
fn();
