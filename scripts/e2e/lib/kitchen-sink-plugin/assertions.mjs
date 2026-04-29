import fs from "node:fs";
import path from "node:path";

const command = process.argv[2];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

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

function scanLogs() {
  const roots = ["/tmp", path.join(process.env.HOME, ".openclaw")];
  const files = [];
  const visit = (entry) => {
    if (!fs.existsSync(entry)) {
      return;
    }
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) {
        visit(path.join(entry, child));
      }
      return;
    }
    if (/\.(?:log|jsonl)$/u.test(entry) || /openclaw-kitchen-sink-/u.test(path.basename(entry))) {
      if (entry.includes("/.npm/_logs/")) {
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
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (allow.some((pattern) => pattern.test(line))) {
        return;
      }
      if (deny.some((pattern) => pattern.test(line))) {
        findings.push(`${file}:${index + 1}: ${line}`);
      }
    });
  }
  if (findings.length > 0) {
    throw new Error(`unexpected error-like log lines:\n${findings.join("\n")}`);
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

function assertInstalled() {
  const pluginId = process.env.KITCHEN_SINK_ID;
  const spec = process.env.KITCHEN_SINK_SPEC;
  const source = process.env.KITCHEN_SINK_SOURCE;
  const surfaceMode = process.env.KITCHEN_SINK_SURFACE_MODE;
  const label = process.env.KITCHEN_SINK_LABEL;
  const list = readJson(`/tmp/kitchen-sink-${label}-plugins.json`);
  const inspect = readJson(`/tmp/kitchen-sink-${label}-inspect.json`);
  const allInspect = readJson(`/tmp/kitchen-sink-${label}-inspect-all.json`);
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

  expectIncludes(inspect.plugin?.channelIds, "kitchen-sink-channel", "channels");
  expectIncludes(inspect.plugin?.providerIds, "kitchen-sink-provider", "providers");

  const diagnostics = [
    ...(list.diagnostics || []),
    ...(inspect.diagnostics || []),
    ...(allInspect.diagnostics || []),
  ];
  const errorMessages = new Set(
    diagnostics.filter((diag) => diag?.level === "error").map((diag) => String(diag.message || "")),
  );

  if (surfaceMode === "full") {
    const toolNames = Array.isArray(inspect.tools)
      ? inspect.tools.flatMap((entry) => (Array.isArray(entry?.names) ? entry.names : []))
      : [];
    const pluginSurfaceIds = {
      speechProviderIds: ["kitchen-sink-speech-provider", "speech providers"],
      realtimeTranscriptionProviderIds: [
        "kitchen-sink-realtime-transcription-provider",
        "realtime transcription providers",
      ],
      realtimeVoiceProviderIds: [
        "kitchen-sink-realtime-voice-provider",
        "realtime voice providers",
      ],
      mediaUnderstandingProviderIds: [
        "kitchen-sink-media-understanding-provider",
        "media understanding providers",
      ],
      imageGenerationProviderIds: [
        "kitchen-sink-image-generation-provider",
        "image generation providers",
      ],
      videoGenerationProviderIds: [
        "kitchen-sink-video-generation-provider",
        "video generation providers",
      ],
      musicGenerationProviderIds: [
        "kitchen-sink-music-generation-provider",
        "music generation providers",
      ],
      webFetchProviderIds: ["kitchen-sink-web-fetch-provider", "web fetch providers"],
      webSearchProviderIds: ["kitchen-sink-web-search-provider", "web search providers"],
      migrationProviderIds: ["kitchen-sink-migration-provider", "migration providers"],
      agentHarnessIds: ["kitchen-sink-agent-harness", "agent harnesses"],
    };
    for (const [field, [id, label]] of Object.entries(pluginSurfaceIds)) {
      expectIncludes(inspect.plugin?.[field], id, label);
    }
    expectIncludes(inspect.services, "kitchen-sink-service", "services");
    expectIncludes(inspect.commands, "kitchen-sink-command", "commands");
    expectIncludes(toolNames, "kitchen-sink-tool", "tools");
    if (
      (inspect.plugin?.hookCount || 0) < 30 ||
      !Array.isArray(inspect.typedHooks) ||
      inspect.typedHooks.length < 30
    ) {
      throw new Error(
        `expected kitchen-sink typed hooks to load, got hookCount=${inspect.plugin?.hookCount} typedHooks=${inspect.typedHooks?.length}`,
      );
    }

    const expectedErrorMessages = new Set([
      "only bundled plugins can register agent tool result middleware",
      "cli registration missing explicit commands metadata",
      "only bundled plugins can register Codex app-server extension factories",
      "http route registration missing or invalid auth: /kitchen-sink/http-route",
      "plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: kitchen-sink-memory-embedding-provider",
    ]);
    for (const message of errorMessages) {
      if (!expectedErrorMessages.has(message)) {
        throw new Error(`unexpected kitchen-sink diagnostic error: ${message}`);
      }
    }
    for (const message of expectedErrorMessages) {
      if (!errorMessages.has(message)) {
        throw new Error(`missing expected kitchen-sink diagnostic error: ${message}`);
      }
    }
  } else if (errorMessages.size > 0) {
    throw new Error(`unexpected kitchen-sink diagnostic errors: ${[...errorMessages].join(", ")}`);
  }

  const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
  const index = readJson(indexPath);
  const record = (index.installRecords ?? index.records ?? {})[pluginId];
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
  }
  if (typeof record.installPath !== "string" || record.installPath.length === 0) {
    throw new Error("missing kitchen-sink install path");
  }
  const installPath = record.installPath.replace(/^~(?=$|\/)/u, process.env.HOME);
  if (!fs.existsSync(installPath)) {
    throw new Error(`kitchen-sink install path missing: ${record.installPath}`);
  }
  fs.writeFileSync(`/tmp/kitchen-sink-${label}-install-path.txt`, installPath, "utf8");
}

function assertRemoved() {
  const pluginId = process.env.KITCHEN_SINK_ID;
  const label = process.env.KITCHEN_SINK_LABEL;
  const list = readJson(`/tmp/kitchen-sink-${label}-uninstalled.json`);
  if ((list.plugins || []).some((entry) => entry.id === pluginId)) {
    throw new Error(`kitchen-sink plugin still listed after uninstall: ${pluginId}`);
  }

  const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
  const index = fs.existsSync(indexPath) ? readJson(indexPath) : {};
  const records = index.installRecords ?? index.records ?? {};
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
  const installPathFile = `/tmp/kitchen-sink-${label}-install-path.txt`;
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
  "assert-installed": assertInstalled,
  "assert-removed": assertRemoved,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown kitchen-sink assertion command: ${command}`);
}
fn();
