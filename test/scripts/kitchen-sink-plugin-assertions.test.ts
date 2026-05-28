import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs";
const SWEEP_SCRIPT = "scripts/e2e/lib/kitchen-sink-plugin/sweep.sh";
const REQUIRED_FULL_DIAGNOSTIC_CANARIES = [
  "only bundled plugins can register trusted tool policies",
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
    tools: [{ names: ["kitchen_sink_text"] }],
    typedHooks: Array.from({ length: 30 }, (_, index) => `hook-${index}`),
  };
}

function diagnosticErrors(messages: string[]) {
  return messages.map((message) => ({ level: "error", message }));
}

function runAssertInstalled({
  diagnostics = [],
  env = {},
}: {
  diagnostics?: Array<{ level: string; message: string }>;
  env?: NodeJS.ProcessEnv;
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
    writeJson(inspectJsonPath, fullSurfaceInspectPayload(pluginId));
    writeJson(inspectAllJsonPath, { diagnostics: [] });
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

function runScanLogs({ home, scratchRoot }: { home: string; scratchRoot: string }) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "scan-logs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      KITCHEN_SINK_TMP_DIR: scratchRoot,
    },
  });
}

describe("kitchen-sink plugin assertions", () => {
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

  it("rejects kitchen-sink log scans without an isolated scratch root", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-scan-"));
    try {
      const spawnEnv = { ...process.env, HOME: parent };
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
});
