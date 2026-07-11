// Kitchen Sink Plugin Assertions tests cover kitchen sink plugin assertions script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs";
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const SWEEP_SCRIPT = "scripts/e2e/lib/kitchen-sink-plugin/sweep.sh";
// The shim waits for an explicit log-ready marker; this only bounds a broken fixture process.
const FIXTURE_READY_WAIT_ATTEMPTS = process.env.CI ? 2_000 : 1_000;
const REQUIRED_FULL_DIAGNOSTIC_CANARIES = [
  "agent tool result middleware must be a function",
  "trusted tool policy registration requires id, description, and evaluate()",
  "plugin must declare contracts.tools for: kitchen-sink-tool",
  'channel "kitchen-sink-channel-probe" registration missing required config helpers',
  'agent harness "kitchen-sink-agent-harness" registration missing required runtime methods',
  "session scheduler job registration requires unique id, sessionKey, and kind",
];

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fullSurfaceInspectPayload(pluginId: string) {
  return {
    commands: ["kitchen"],
    diagnostics: [],
    plugin: {
      id: pluginId,
      enabled: true,
      status: "loaded",
      contextEngineIds: [pluginId],
      channelIds: ["kitchen-sink-channel"],
      providerIds: ["kitchen-sink-provider"],
      speechProviderIds: ["kitchen-sink-speech"],
      realtimeTranscriptionProviderIds: ["kitchen-sink-realtime-transcription"],
      realtimeVoiceProviderIds: ["kitchen-sink-realtime-voice"],
      mediaUnderstandingProviderIds: ["kitchen-sink-media"],
      imageGenerationProviderIds: ["kitchen-sink-image"],
      videoGenerationProviderIds: ["kitchen-sink-video"],
      musicGenerationProviderIds: ["kitchen-sink-music"],
      webFetchProviderIds: ["kitchen-sink-fetch"],
      webSearchProviderIds: ["kitchen-sink-search"],
      migrationProviderIds: ["kitchen-sink-migration-providers"],
      agentHarnessIds: [],
      hookCount: 30,
    },
    services: ["kitchen-sink-service"],
    tools: [{ names: ["kitchen_sink_text", "kitchen_sink_search", "kitchen_sink_image_job"] }],
    typedHooks: Array.from({ length: 30 }, (_, index) => `hook-${index}`),
  };
}

function diagnosticErrors(messages: string[]) {
  return messages.map((message) => ({ level: "error", message }));
}

function runAssertInstalled({
  allInspectPayload,
  diagnostics = [],
  env = {},
  inspectPayload,
}: {
  allInspectPayload?: unknown;
  diagnostics?: Array<{ level: string; message: string }>;
  env?: NodeJS.ProcessEnv;
  inspectPayload?: ReturnType<typeof fullSurfaceInspectPayload>;
} = {}) {
  const label = `diagnostics-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pluginId = "openclaw-kitchen-sink-fixture";
  const home = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-home-"));
  const installPath = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-install-"));
  const scratchRoot = tmpdir();
  const pluginsJsonPath = path.join(scratchRoot, `kitchen-sink-${label}-plugins.json`);
  const inspectJsonPath = path.join(scratchRoot, `kitchen-sink-${label}-inspect.json`);
  const inspectAllJsonPath = path.join(scratchRoot, `kitchen-sink-${label}-inspect-all.json`);
  const installPathMarker = path.join(scratchRoot, `kitchen-sink-${label}-install-path.txt`);
  const installsPath = path.join(home, ".openclaw", "plugins", "installs.json");
  const spawnEnv = { ...process.env };
  delete spawnEnv.KITCHEN_SINK_REQUIRE_ALL_DIAGNOSTICS;

  try {
    writeJson(pluginsJsonPath, {
      diagnostics,
      plugins: [{ id: pluginId, status: "loaded" }],
    });
    const pluginInspectPayload = inspectPayload ?? fullSurfaceInspectPayload(pluginId);
    writeJson(inspectJsonPath, pluginInspectPayload);
    writeJson(inspectAllJsonPath, allInspectPayload ?? [pluginInspectPayload]);
    writeJson(installsPath, {
      installRecords: {
        [pluginId]: {
          installPath,
          resolvedSpec: "@openclaw/kitchen-sink@latest",
          resolvedVersion: "1.0.0",
          source: "npm",
          spec: "@openclaw/kitchen-sink@latest",
        },
      },
    });

    return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "assert-installed"], {
      encoding: "utf8",
      env: {
        ...spawnEnv,
        ...env,
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        KITCHEN_SINK_ID: pluginId,
        KITCHEN_SINK_LABEL: label,
        KITCHEN_SINK_SOURCE: "npm",
        KITCHEN_SINK_SPEC: "npm:@openclaw/kitchen-sink@latest",
        KITCHEN_SINK_SURFACE_MODE: "full",
        KITCHEN_SINK_TMP_DIR: scratchRoot,
      },
    });
  } finally {
    rmSync(home, { force: true, recursive: true });
    rmSync(installPath, { force: true, recursive: true });
    rmSync(pluginsJsonPath, { force: true });
    rmSync(inspectJsonPath, { force: true });
    rmSync(inspectAllJsonPath, { force: true });
    rmSync(installPathMarker, { force: true });
  }
}

function runAssertClawhubInstalled({
  contextEngineIds = [],
  installPathRelative,
}: {
  contextEngineIds?: string[];
  installPathRelative?: string;
} = {}) {
  const label = `clawhub-context-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pluginId = "openclaw-kitchen-sink-fixture";
  const home = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-home-"));
  const installPath = installPathRelative
    ? `${home}${path.sep}${installPathRelative}`
    : path.join(home, ".openclaw", "extensions", pluginId);
  const scratchRoot = tmpdir();
  const pluginsJsonPath = path.join(scratchRoot, `kitchen-sink-${label}-plugins.json`);
  const inspectJsonPath = path.join(scratchRoot, `kitchen-sink-${label}-inspect.json`);
  const inspectAllJsonPath = path.join(scratchRoot, `kitchen-sink-${label}-inspect-all.json`);
  const installPathMarker = path.join(scratchRoot, `kitchen-sink-${label}-install-path.txt`);
  const installsPath = path.join(home, ".openclaw", "plugins", "installs.json");
  try {
    mkdirSync(path.join(home, ".openclaw", "extensions"), { recursive: true });
    mkdirSync(installPath, { recursive: true });
    const inspectPayload = fullSurfaceInspectPayload(pluginId);
    inspectPayload.plugin.contextEngineIds = contextEngineIds;
    writeJson(pluginsJsonPath, {
      diagnostics: [],
      plugins: [{ id: pluginId, status: "loaded" }],
    });
    writeJson(inspectJsonPath, inspectPayload);
    writeJson(inspectAllJsonPath, [inspectPayload]);
    writeJson(installsPath, {
      installRecords: {
        [pluginId]: {
          artifactFormat: "zip",
          artifactKind: "legacy-zip",
          clawhubFamily: "code-plugin",
          clawhubPackage: "@openclaw/kitchen-sink",
          integrity: "sha256-test",
          installPath,
          resolvedSpec: "clawhub:@openclaw/kitchen-sink@latest",
          resolvedVersion: "1.0.0",
          resolvedAt: 1,
          source: "clawhub",
          spec: "clawhub:@openclaw/kitchen-sink@latest",
          version: "1.0.0",
        },
      },
    });

    return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "assert-installed"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        KITCHEN_SINK_ID: pluginId,
        KITCHEN_SINK_LABEL: label,
        KITCHEN_SINK_SOURCE: "clawhub",
        KITCHEN_SINK_SPEC: "clawhub:@openclaw/kitchen-sink@latest",
        KITCHEN_SINK_SURFACE_MODE: "basic",
        KITCHEN_SINK_TMP_DIR: scratchRoot,
      },
    });
  } finally {
    rmSync(home, { force: true, recursive: true });
    rmSync(pluginsJsonPath, { force: true });
    rmSync(inspectJsonPath, { force: true });
    rmSync(inspectAllJsonPath, { force: true });
    rmSync(installPathMarker, { force: true });
  }
}

function runScanLogs({
  env = {},
  home,
  scratchRoot,
}: {
  env?: NodeJS.ProcessEnv;
  home: string;
  scratchRoot: string;
}) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "scan-logs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      HOME: home,
      KITCHEN_SINK_TMP_DIR: scratchRoot,
    },
  });
}

function runSweepShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(BASH_BIN, ["-c", toBashScript(script)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...toBashEnv(env) },
  });
}

function toBashScript(script: string) {
  if (process.platform === "win32") {
    return `export PATH="/usr/bin:/bin:$PATH"\n${script}`;
  }
  return script;
}

function toBashEnv(env: NodeJS.ProcessEnv) {
  if (process.platform !== "win32") {
    return env;
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      typeof value === "string" ? toGitBashPath(value) : value,
    ]),
  );
}

function toGitBashPath(value: string) {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(value);
  if (!match) {
    return value;
  }

  return `/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

describe("kitchen-sink plugin assertions", () => {
  it("bounds expected-failure output before matching failure diagnostics", () => {
    const scratchRoot = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-failure-cap-"));
    const outputPath = path.join(scratchRoot, "expected-failure.log");
    try {
      writeFileSync(outputPath, "x".repeat(128));

      const result = spawnSync(
        process.execPath,
        [ASSERTIONS_SCRIPT, "expect-failure", outputPath],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            KITCHEN_SINK_EXPECT_FAILURE_OUTPUT_MAX_BYTES: "64",
            KITCHEN_SINK_SOURCE: "npm",
            KITCHEN_SINK_SPEC: "npm:@openclaw/kitchen-sink@0.0.0",
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("expected failure output exceeded 64 bytes");
    } finally {
      rmSync(scratchRoot, { force: true, recursive: true });
    }
  });

  it("fails full-surface installs when stable diagnostic canaries disappear", () => {
    const result = runAssertInstalled();

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "missing expected kitchen-sink diagnostic error",
    );
  });

  it("accepts published full-surface installs with stable diagnostic canaries", () => {
    const result = runAssertInstalled({
      diagnostics: diagnosticErrors(REQUIRED_FULL_DIAGNOSTIC_CANARIES),
    });

    expect(result.status).toBe(0);
  });

  it("requires kitchen-sink plugins to appear in inspect-all output", () => {
    const result = runAssertInstalled({
      allInspectPayload: [fullSurfaceInspectPayload("other-plugin")],
      diagnostics: diagnosticErrors(REQUIRED_FULL_DIAGNOSTIC_CANARIES),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "kitchen-sink plugin missing from inspect --all output",
    );
  });

  it("fails kitchen-sink inspect-all diagnostics for the installed plugin", () => {
    const inspectPayload = fullSurfaceInspectPayload("openclaw-kitchen-sink-fixture");
    const result = runAssertInstalled({
      allInspectPayload: [
        {
          ...inspectPayload,
          diagnostics: [{ level: "error", message: "inspect-all runtime failed" }],
        },
      ],
      diagnostics: diagnosticErrors(REQUIRED_FULL_DIAGNOSTIC_CANARIES),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("inspect-all runtime failed");
  });

  it("requires the full kitchen-sink tool surface in full mode", () => {
    const inspectPayload = fullSurfaceInspectPayload("openclaw-kitchen-sink-fixture");
    inspectPayload.tools = [{ names: ["kitchen_sink_text"] }];
    const result = runAssertInstalled({
      diagnostics: diagnosticErrors(REQUIRED_FULL_DIAGNOSTIC_CANARIES),
      inspectPayload,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("tools missing kitchen_sink_search");
  });

  it("requires ClawHub kitchen-sink fixtures to expose context engines", () => {
    const result = runAssertClawhubInstalled({ contextEngineIds: [] });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("context engines missing");
  });

  it("accepts ClawHub kitchen-sink fixtures with a context engine", () => {
    const result = runAssertClawhubInstalled({
      contextEngineIds: ["openclaw-kitchen-sink-fixture"],
    });

    expect(result.status).toBe(0);
  });

  it("rejects ClawHub kitchen-sink install paths that resolve outside managed extensions", () => {
    const result = runAssertClawhubInstalled({
      contextEngineIds: ["openclaw-kitchen-sink-fixture"],
      installPathRelative: [".openclaw", "extensions", "..", "escaped-kitchen-sink"].join(path.sep),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("kitchen-sink ClawHub install path resolved outside");
  });

  it("keeps exhaustive diagnostic matching available for synchronized fixtures", () => {
    const result = runAssertInstalled({
      diagnostics: diagnosticErrors(REQUIRED_FULL_DIAGNOSTIC_CANARIES),
      env: { KITCHEN_SINK_REQUIRE_ALL_DIAGNOSTICS: "1" },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "cli registration missing explicit commands metadata",
    );
  });

  it("scans only the configured kitchen-sink scratch root", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-scan-"));
    const home = path.join(parent, "home");
    const scratchRoot = path.join(parent, "scratch");
    const siblingRoot = path.join(parent, "sibling");
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(scratchRoot, { recursive: true });
      mkdirSync(siblingRoot, { recursive: true });
      writeFileSync(path.join(scratchRoot, "large.log"), `${"x".repeat(70 * 1024)}\n0 errors\n`);
      writeFileSync(path.join(siblingRoot, "stale.log"), "[ERROR] stale sibling failure\n");

      const result = runScanLogs({ home, scratchRoot });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("log scan passed");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("stale sibling failure");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("bounds irrelevant OpenClaw home traversal during log scans", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-scan-"));
    const home = path.join(parent, "home");
    const scratchRoot = path.join(parent, "scratch");
    try {
      mkdirSync(path.join(home, ".openclaw"), { recursive: true });
      mkdirSync(scratchRoot, { recursive: true });
      writeFileSync(path.join(scratchRoot, "scenario.log"), "0 errors\n");
      for (let index = 0; index < 20; index += 1) {
        const dir = path.join(home, ".openclaw", `cache-${index}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "state.txt"), "not a log\n");
      }

      const result = runScanLogs({
        env: { KITCHEN_SINK_LOG_SCAN_MAX_ENTRIES: "8" },
        home,
        scratchRoot,
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "kitchen-sink log scan exceeded 8 filesystem entries",
      );
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("streams kitchen-sink log directories instead of sorting full child lists", () => {
    const source = readFileSync(ASSERTIONS_SCRIPT, "utf8");

    expect(source).toContain("fs.opendirSync(entry)");
    expect(source).not.toContain("fs.readdirSync(entry).toSorted");
  });

  it("does not allow dirty error lines just because they mention zero errors", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-scan-"));
    const home = path.join(parent, "home");
    const scratchRoot = path.join(parent, "scratch");
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(scratchRoot, { recursive: true });
      writeFileSync(
        path.join(scratchRoot, "dirty.log"),
        "[ERROR] 0 errors reported but fatal state remained\n",
      );

      const result = runScanLogs({ home, scratchRoot });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("unexpected error-like log lines");
      expect(`${result.stdout}\n${result.stderr}`).toContain("fatal state remained");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("rejects kitchen-sink log scans that find no files", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-scan-"));
    const home = path.join(parent, "home");
    const scratchRoot = path.join(parent, "scratch");
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(scratchRoot, { recursive: true });

      const result = runScanLogs({ home, scratchRoot });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "kitchen-sink log scan found no files",
      );
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("bounds repeated kitchen-sink log scan findings", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-scan-"));
    const home = path.join(parent, "home");
    const scratchRoot = path.join(parent, "scratch");
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(scratchRoot, { recursive: true });
      writeFileSync(
        path.join(scratchRoot, "errors.log"),
        Array.from({ length: 105 }, (_, index) => `[ERROR] failure ${index}`).join("\n"),
      );

      const result = runScanLogs({ home, scratchRoot });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("additional findings omitted");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("[ERROR] failure 104");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("bounds huge single-line kitchen-sink log findings", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-scan-"));
    const home = path.join(parent, "home");
    const scratchRoot = path.join(parent, "scratch");
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(scratchRoot, { recursive: true });
      writeFileSync(
        path.join(scratchRoot, "single-line.jsonl"),
        `DO_NOT_DUMP_OLD_PREFIX${"x".repeat(256 * 1024)}recent marker [ERROR] bad state`,
      );

      const result = runScanLogs({ home, scratchRoot });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("recent marker");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("DO_NOT_DUMP_OLD_PREFIX");
      expect(`${result.stdout}\n${result.stderr}`.length).toBeLessThan(25 * 1024);
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("detects kitchen-sink log errors split across scan segment boundaries", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-scan-"));
    const home = path.join(parent, "home");
    const scratchRoot = path.join(parent, "scratch");
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(scratchRoot, { recursive: true });
      writeFileSync(
        path.join(scratchRoot, "split-marker.jsonl"),
        `${"x".repeat(16 * 1024 - 3)}[ERROR] split boundary marker`,
      );

      const result = runScanLogs({ home, scratchRoot });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("split boundary marker");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("rejects kitchen-sink log scans without an isolated scratch root", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-scan-"));
    try {
      const spawnEnv: NodeJS.ProcessEnv = { ...process.env, HOME: parent };
      delete spawnEnv.KITCHEN_SINK_TMP_DIR;
      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "scan-logs"], {
        encoding: "utf8",
        env: spawnEnv,
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("KITCHEN_SINK_TMP_DIR is required");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("allocates an isolated scratch root by default", () => {
    const sweep = readFileSync(SWEEP_SCRIPT, "utf8");

    expect(sweep).toContain('mktemp -d "/tmp/openclaw-kitchen-sink.XXXXXX"');
    expect(sweep).toContain('mktemp -d "${KITCHEN_SINK_TMP_DIR}/clawhub.XXXXXX"');
    expect(sweep).not.toContain('KITCHEN_SINK_TMP_DIR="${KITCHEN_SINK_TMP_DIR:-/tmp}"');
    expect(sweep).not.toContain('mktemp -d "/tmp/openclaw-kitchen-sink-clawhub.XXXXXX"');
  });

  it("cleans the default kitchen-sink scratch root", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-cleanup-"));
    const marker = path.join(parent, "scratch-path.txt");
    try {
      const result = runSweepShell(
        `
set -euo pipefail
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
printf '%s\\n' "$KITCHEN_SINK_TMP_DIR" > "$MARKER"
test -d "$KITCHEN_SINK_TMP_DIR"
cleanup_kitchen_sink_sweep
test ! -e "$KITCHEN_SINK_TMP_DIR"
`,
        { MARKER: marker },
      );

      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const scratchRoot = readFileSync(marker, "utf8").trim();
      expect(scratchRoot).toContain("/tmp/openclaw-kitchen-sink.");
      expect(existsSync(scratchRoot)).toBe(false);
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("preserves successful kitchen-sink CLI command logs for the final scan", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-log-"));
    const scratchRoot = path.join(parent, "scratch");
    const entry = path.join(parent, "entry.mjs");
    try {
      mkdirSync(scratchRoot, { recursive: true });
      writeFileSync(entry, "console.log(`cli transcript: ${process.argv.slice(2).join(' ')}`);\n");

      const result = runSweepShell(
        `
set -euo pipefail
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_ENTRY="$ENTRY"
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
run_kitchen_sink_openclaw_logged "install/log" plugins install demo
test -f "$SCRATCH_ROOT/install_log.log"
grep -q "cli transcript: plugins install demo" "$SCRATCH_ROOT/install_log.log"
`,
        {
          ENTRY: entry,
          SCRATCH_ROOT: scratchRoot,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("cli transcript: plugins install demo");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("bounds printed kitchen-sink CLI command logs without truncating saved logs", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-log-print-"));
    const scratchRoot = path.join(parent, "scratch");
    const entry = path.join(parent, "entry.mjs");
    try {
      mkdirSync(scratchRoot, { recursive: true });
      writeFileSync(
        entry,
        'process.stdout.write(`prefix\\n${"x".repeat(2048)}\\nTAIL_MARKER\\n`);\n',
      );

      const result = runSweepShell(
        `
set -euo pipefail
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_ENTRY="$ENTRY"
export OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=64
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
run_kitchen_sink_openclaw_logged "install/noisy" plugins install demo
grep -q "prefix" "$SCRATCH_ROOT/install_noisy.log"
`,
        {
          ENTRY: entry,
          SCRATCH_ROOT: scratchRoot,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("truncated: showing last 64");
      expect(result.stdout).toContain("TAIL_MARKER");
      expect(result.stdout).not.toContain("prefix");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("rejects invalid kitchen-sink log byte limits before CLI setup", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-log-invalid-"));
    const scratchRoot = path.join(parent, "scratch");
    const entry = path.join(parent, "entry.mjs");
    try {
      mkdirSync(scratchRoot, { recursive: true });
      writeFileSync(entry, "console.log('should not run');\n");

      const result = runSweepShell(
        `
set -euo pipefail
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_ENTRY="$ENTRY"
export OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=64kb
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
run_kitchen_sink_openclaw_logged "install/log" plugins install demo
`,
        {
          ENTRY: entry,
          SCRATCH_ROOT: scratchRoot,
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: 64kb");
      expect(result.stdout).not.toContain("should not run");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("includes expected-failure transcripts in the final kitchen-sink log scan", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-failure-log-"));
    const home = path.join(parent, "home");
    const scratchRoot = path.join(parent, "scratch");
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(scratchRoot, { recursive: true });

      const result = runSweepShell(
        `
set -euo pipefail
export HOME="$HOME_DIR"
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export KITCHEN_SINK_SOURCE=npm
export KITCHEN_SINK_SPEC=npm:@openclaw/kitchen-sink@0.0.0
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
run_expect_failure "install/failure" bash -c 'printf "%s\\n" "npm ERR! No matching version @openclaw/kitchen-sink@0.0.0"; exit 1'
test -f "$SCRATCH_ROOT/kitchen-sink-expected-failure-install_failure.log"
scan_logs_for_unexpected_errors
`,
        {
          HOME_DIR: home,
          SCRATCH_ROOT: scratchRoot,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("log scan passed");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("cleans a ClawHub fixture server that times out before readiness", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-clawhub-"));
    const fakeBin = path.join(parent, "bin");
    const scratchRoot = path.join(parent, "scratch");
    const fixtureDir = path.join(scratchRoot, "clawhub-fixture");
    const nodeShim = path.join(fakeBin, "node");
    try {
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(nodeShim, "#!/usr/bin/env bash\nsleep 30\n");
      chmodSync(nodeShim, 0o755);

      const result = runSweepShell(
        `
set -euo pipefail
export PATH="$FAKE_BIN:$PATH"
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS=1
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
set +e
start_kitchen_sink_clawhub_fixture_server "$FIXTURE_DIR"
status="$?"
set -e
if [[ "$status" -eq 0 ]]; then
  echo "fixture unexpectedly became ready" >&2
  exit 1
fi
server_pid="$(cat "$FIXTURE_DIR/clawhub-fixture-pid")"
kill -0 "$server_pid"
cleanup_kitchen_sink_sweep
if kill -0 "$server_pid" 2>/dev/null; then
  echo "fixture server still running after cleanup" >&2
  exit 1
fi
test ! -e "$FIXTURE_DIR"
test -d "$SCRATCH_ROOT"
`,
        {
          FAKE_BIN: fakeBin,
          FIXTURE_DIR: fixtureDir,
          SCRATCH_ROOT: scratchRoot,
        },
      );

      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Timed out waiting for kitchen-sink ClawHub fixture server.",
      );
      expect(existsSync(fixtureDir)).toBe(false);
      expect(existsSync(scratchRoot)).toBe(true);
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("rejects invalid ClawHub fixture wait attempts before starting the server", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-clawhub-attempts-"));
    const fakeBin = path.join(parent, "bin");
    const scratchRoot = path.join(parent, "scratch");
    const fixtureDir = path.join(scratchRoot, "clawhub-fixture");
    const nodeShim = path.join(fakeBin, "node");
    try {
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(nodeShim, "#!/usr/bin/env bash\necho node should not run >&2\nexit 1\n");
      chmodSync(nodeShim, 0o755);

      const result = runSweepShell(
        `
set -euo pipefail
export PATH="$FAKE_BIN:$PATH"
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS=2x
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
set +e
start_kitchen_sink_clawhub_fixture_server "$FIXTURE_DIR"
status="$?"
set -e
cleanup_kitchen_sink_sweep
exit "$status"
`,
        {
          FAKE_BIN: fakeBin,
          FIXTURE_DIR: fixtureDir,
          SCRATCH_ROOT: scratchRoot,
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS: 2x");
      expect(result.stderr).not.toContain("node should not run");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("bounds ClawHub fixture server logs on startup timeout", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-clawhub-log-"));
    const fakeBin = path.join(parent, "bin");
    const scratchRoot = path.join(parent, "scratch");
    const fixtureDir = path.join(scratchRoot, "clawhub-fixture");
    const nodeShim = path.join(fakeBin, "node");
    const sleepShim = path.join(fakeBin, "sleep");
    const fixtureReadyPath = path.join(parent, "fixture-log-ready");
    try {
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(
        nodeShim,
        [
          "#!/usr/bin/env bash",
          "printf 'DO_NOT_DUMP_CLAWHUB_PREFIX\\n'",
          "head -c 2048 /dev/zero | tr '\\0' x",
          "printf '\\nFIXTURE_TAIL_MARKER\\n'",
          ': >"$FIXTURE_READY_PATH"',
          "/bin/sleep 30",
          "",
        ].join("\n"),
      );
      chmodSync(nodeShim, 0o755);
      writeFileSync(
        sleepShim,
        [
          "#!/usr/bin/env bash",
          'for _ in $(seq 1 "$FIXTURE_READY_WAIT_ATTEMPTS"); do',
          '  [[ -f "$FIXTURE_READY_PATH" ]] && exit 0',
          "  /bin/sleep 0.01",
          "done",
          "exit 1",
          "",
        ].join("\n"),
      );
      chmodSync(sleepShim, 0o755);

      const result = runSweepShell(
        `
set -euo pipefail
export PATH="$FAKE_BIN:$PATH"
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS=1
export OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=64
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
set +e
start_kitchen_sink_clawhub_fixture_server "$FIXTURE_DIR"
status="$?"
set -e
cleanup_kitchen_sink_sweep
exit "$status"
`,
        {
          FAKE_BIN: fakeBin,
          FIXTURE_DIR: fixtureDir,
          FIXTURE_READY_PATH: fixtureReadyPath,
          FIXTURE_READY_WAIT_ATTEMPTS: String(FIXTURE_READY_WAIT_ATTEMPTS),
          SCRATCH_ROOT: scratchRoot,
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("truncated: showing last 64");
      expect(result.stdout).toContain("FIXTURE_TAIL_MARKER");
      expect(result.stdout).not.toContain("DO_NOT_DUMP_CLAWHUB_PREFIX");
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });
});
