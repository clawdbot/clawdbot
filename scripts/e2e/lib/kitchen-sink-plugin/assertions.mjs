import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";

const command = process.argv[2];
const scratchRoot = process.env.KITCHEN_SINK_TMP_DIR || os.tmpdir();

const LOG_SCAN_CHUNK_BYTES = 64 * 1024;
const LOG_SCAN_MAX_FINDINGS = 100;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const scratchFile = (name) => path.join(scratchRoot, name);
const normalizedPath = (filePath) => filePath.replaceAll("\\", "/");

function resolveHomePath(value) {
  if (value === "~") {
    return process.env.HOME;
  }
  if (value?.startsWith("~/") || value?.startsWith("~\\")) {
    return path.join(process.env.HOME, value.slice(2));
  }
  return value;
}

function expectFailure() {
  const outputFile = process.argv[3];
  const output = fs.readFileSync(outputFile, "utf8");
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
    let carry = "";
    let lineNumber = 1;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = carry + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split(/\r?\n/u);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (onLine(line, lineNumber) === false) {
          return;
        }
        lineNumber += 1;
      }
    }
    if (carry.length > 0) {
      onLine(carry, lineNumber);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function scanLogs() {
  if (!process.env.KITCHEN_SINK_TMP_DIR) {
    throw new Error("KITCHEN_SINK_TMP_DIR is required for kitchen-sink log scans");
  }
  const roots = [scratchRoot, path.join(process.env.HOME, ".openclaw")];
  const files = [];
  const visit = (entry) => {
    if (!fs.existsSync(entry)) {
      return;
    }
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) {
        visit(path.join(entry, child));
      }
      return;
    }
    if (/\.(?:log|jsonl)$/u.test(entry) || /openclaw-kitchen-sink-/u.test(path.basename(entry))) {
      if (normalizedPath(entry).includes("/.npm/_logs/")) {
        return;
      }
      files.push(entry);
    }
  };
  for (const root of roots) {
    visit(root);
  }

  const deny = [
    /\buncaught exception\b/iu,
    /\bunhandled rejection\b/iu,
    /\bfatal\b/iu,
    /\bpanic\b/iu,
    /\blevel["']?\s*:\s*["']error["']/iu,
    /\[(?:error|ERROR)\]/u,
  ];
  const allow = [/0 errors?/iu, /expected no diagnostics errors?/iu, /diagnostics errors?:\s*$/iu];
  const findings = [];
  let omittedFindings = false;
  for (const file of files) {
    scanTextFileLines(file, (line, lineNumber) => {
      if (allow.some((pattern) => pattern.test(line))) {
        return true;
      }
      if (deny.some((pattern) => pattern.test(line))) {
        if (findings.length >= LOG_SCAN_MAX_FINDINGS) {
          omittedFindings = true;
          return false;
        }
        findings.push(`${file}:${lineNumber}: ${line}`);
      }
      return true;
    });
    if (omittedFindings) {
      break;
    }
  }
  if (findings.length > 0) {
    const suffix = omittedFindings ? "\n... additional findings omitted" : "";
    throw new Error(`unexpected error-like log lines:\n${findings.join("\n")}${suffix}`);
  }
  console.log(`log scan passed (${files.length} file(s))`);
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
  "only bundled plugins can register trusted tool policies",
  "plugin must declare contracts.tools for: kitchen-sink-tool",
  'channel "kitchen-sink-channel-probe" registration missing required config helpers',
  'agent harness "kitchen-sink-agent-harness" registration missing required runtime methods',
  "session scheduler job registration requires unique id, sessionKey, and kind",
]);

function assertExpectedDiagnostics(surfaceMode, errorMessages) {
  const expectedErrorMessages = new Set([
    "cli registration missing explicit commands metadata",
    "only bundled plugins can register Codex app-server extension factories",
    "only bundled plugins can register agent tool result middleware",
    'compaction provider "kitchen-sink-compaction-provider" registration missing summarize',
    "context engine registration missing id",
    "control UI descriptor registration requires id, surface, label, and valid optional fields",
    "hosted media resolver registration missing resolver",
    "http route registration missing or invalid auth: /kitchen-sink/http-route",
    "node invoke policy registration missing commands",
    "only bundled plugins can register trusted tool policies",
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
  const plugin = (list.plugins || []).find((entry) => entry.id === pluginId);
  if (!plugin) {
    throw new Error(`kitchen-sink plugin not found after install: ${pluginId}`);
  }
  if (plugin.status !== "loaded") {
    throw new Error(`unexpected kitchen-sink status after enable: ${plugin.status}`);
  }
  if (inspect.plugin?.id !== pluginId) {
    throw new Error(`unexpected inspected kitchen-sink plugin id: ${inspect.plugin?.id}`);
  }
  if (inspect.plugin?.enabled !== true || inspect.plugin?.status !== "loaded") {
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
    ...(allInspect.diagnostics || []),
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
      expectIncludesAny(toolNames, ["kitchen_sink_text", "kitchen-sink-tool"], "tools");
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
