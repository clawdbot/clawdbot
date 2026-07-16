// Qa Lab tests cover Multipass behavior through the production runner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runExecMock = vi.hoisted(() => vi.fn());
const TEST_ENV_VALUE = "qa-fixture-value";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    runExec: runExecMock,
  };
});

import { runQaMultipass } from "./multipass.runtime.js";

const generatedPaths: string[] = [];

function missingMultipassError() {
  return Object.assign(new Error("spawn multipass ENOENT"), { code: "ENOENT" });
}

async function renderPersistedGuestScript(
  params: Omit<Parameters<typeof runQaMultipass>[0], "repoRoot" | "outputDir"> & {
    outputDirName: string;
  },
) {
  const { outputDirName, ...runParams } = params;
  const outputDir = path.join(process.cwd(), ".artifacts", "qa-e2e", outputDirName);
  generatedPaths.push(outputDir);
  await expect(
    runQaMultipass({
      repoRoot: process.cwd(),
      outputDir,
      ...runParams,
    }),
  ).rejects.toThrow("Multipass is not installed on this host.");
  return fs.readFileSync(path.join(outputDir, "multipass-guest-run.sh"), "utf8");
}

async function captureGuestScriptsAtTransfer(
  params: Omit<Parameters<typeof runQaMultipass>[0], "repoRoot" | "outputDir"> & {
    outputDirName: string;
  },
) {
  const { outputDirName, ...runParams } = params;
  const outputDir = path.join(process.cwd(), ".artifacts", "qa-e2e", outputDirName);
  let executableScript = "";
  generatedPaths.push(outputDir);
  runExecMock.mockImplementation(async (_file: string, args: string[]) => {
    const transferSourcePath = args[1];
    if (
      args[0] === "transfer" &&
      transferSourcePath &&
      path.basename(transferSourcePath) === "guest-run.sh"
    ) {
      executableScript = fs.readFileSync(transferSourcePath, "utf8");
      throw new Error("stop after guest script transfer");
    }
    return { stdout: "", stderr: "" };
  });

  await expect(
    runQaMultipass({
      repoRoot: process.cwd(),
      outputDir,
      ...runParams,
    }),
  ).rejects.toThrow("stop after guest script transfer");

  expect(executableScript).not.toBe("");
  return {
    executableScript,
    persistedScript: fs.readFileSync(path.join(outputDir, "multipass-guest-run.sh"), "utf8"),
  };
}

describe("qa multipass runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runExecMock.mockRejectedValue(missingMultipassError());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const generatedPath of generatedPaths.splice(0)) {
      fs.rmSync(generatedPath, { recursive: true, force: true });
    }
  });

  it("rejects output directories outside the mounted repo root", async () => {
    await expect(
      runQaMultipass({
        repoRoot: process.cwd(),
        outputDir: "/tmp/qa-out",
      }),
    ).rejects.toThrow(
      "qa suite --runner multipass requires --output-dir to stay under the repo root",
    );
  });

  it("rejects repo-local symlink output directories that escape the repo root", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-multipass-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideRoot = path.join(tempRoot, "outside");
    const symlinkPath = path.join(repoRoot, "artifacts-link");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.32.1" }),
      "utf8",
    );
    fs.symlinkSync(outsideRoot, symlinkPath);

    try {
      await expect(
        runQaMultipass({
          repoRoot,
          outputDir: path.join(symlinkPath, "qa-out"),
        }),
      ).rejects.toThrow(
        "qa suite --runner multipass requires --output-dir to stay under the repo root",
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists the default live suite command and mounted artifact path", async () => {
    const script = await renderPersistedGuestScript({
      outputDirName: "multipass-default-test",
      scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
    });

    expect(script).toContain("pnpm install --frozen-lockfile");
    expect(script).toContain("pnpm build");
    expect(script).toContain("corepack prepare 'pnpm@");
    expect(script).toContain(
      'curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 --retry-max-time 120 "${base_url}/SHASUMS256.txt" -o "${node_tmp_dir}/SHASUMS256.txt"',
    );
    expect(script).toContain(
      'curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 --retry-max-time 120 "${base_url}/${tarball_name}" -o "${node_tmp_dir}/${tarball_name}"',
    );
    expect(script).toContain("'pnpm' 'openclaw' 'qa' 'suite' '--transport' 'qa-channel'");
    expect(script).toContain("'--provider-mode' 'live-frontier'");
    expect(script).toContain("'--scenario' 'channel-chat-baseline'");
    expect(script).toContain("'--scenario' 'thread-follow-up'");
    expect(script).toContain("/workspace/openclaw-host/.artifacts/qa-e2e/multipass-default-test");
  });

  it("redacts persisted credentials while forwarding them to the executable script", async () => {
    vi.stubEnv("OPENAI_API_KEY", TEST_ENV_VALUE);
    const { executableScript, persistedScript } = await captureGuestScriptsAtTransfer({
      outputDirName: "multipass-live-test",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: true,
      allowFailures: true,
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(persistedScript).toContain("OPENAI_API_KEY='<redacted>'");
    expect(persistedScript).not.toContain(TEST_ENV_VALUE);
    expect(executableScript).toContain(`OPENAI_API_KEY='${TEST_ENV_VALUE}'`);
    expect(executableScript).not.toContain("<redacted>");
    expect(persistedScript).toContain("'--model' 'openai/gpt-5.6-luna'");
    expect(persistedScript).toContain("'--alt-model' 'openai/gpt-5.6-luna'");
    expect(persistedScript).toContain("'--fast'");
    expect(persistedScript).toContain("'--allow-failures'");
  });

  it("persists runtime, channel-driver, and plugin selections", async () => {
    const script = await renderPersistedGuestScript({
      outputDirName: "multipass-selection-test",
      runtimePair: ["openclaw", "codex"],
      channelDriverSelection: {
        capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        smokeArtifactPath: "crabline-fake-provider-smoke.json",
      },
      enabledPluginIds: ["browser", "memory-core", "browser"],
    });

    expect(script).toContain("'--runtime-pair' 'openclaw,codex'");
    expect(script).toContain("'--channel-driver' 'crabline' '--channel' 'telegram'");
    expect(script).toContain("'--enable-plugin' 'browser' '--enable-plugin' 'memory-core'");
  });

  it("forwards supported live credential shapes only in redacted form", async () => {
    vi.stubEnv("OPENCLAW_LIVE_ANTHROPIC_KEYS", TEST_ENV_VALUE);
    vi.stubEnv("OPENCLAW_LIVE_CODEX_API_KEY", TEST_ENV_VALUE);
    vi.stubEnv("CODEX_API_KEY", TEST_ENV_VALUE);
    vi.stubEnv("OPENAI_API_KEY_1", TEST_ENV_VALUE);
    vi.stubEnv("GEMINI_API_KEY_2", TEST_ENV_VALUE);
    const script = await renderPersistedGuestScript({
      outputDirName: "multipass-env-test",
      providerMode: "live-frontier",
    });

    for (const key of [
      "OPENCLAW_LIVE_ANTHROPIC_KEYS",
      "OPENCLAW_LIVE_CODEX_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_API_KEY_1",
      "GEMINI_API_KEY_2",
    ]) {
      expect(script).toContain(`${key}='<redacted>'`);
    }
    expect(script).not.toContain(TEST_ENV_VALUE);
  });

  it("omits stale CODEX_HOME values", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/does-not-exist-openclaw-codex-home");
    const script = await renderPersistedGuestScript({
      outputDirName: "multipass-stale-codex-home-test",
      providerMode: "live-frontier",
    });

    expect(script).not.toContain("CODEX_HOME=");
  });

  it("uses os.homedir() when HOME is unset for CODEX_HOME discovery", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-multipass-home-"));
    const fakeHome = path.join(tempRoot, "home");
    fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    vi.stubEnv("HOME", "");
    vi.stubEnv("CODEX_HOME", "");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    try {
      const script = await renderPersistedGuestScript({
        outputDirName: "multipass-home-test",
        providerMode: "live-frontier",
      });
      expect(script).toContain("CODEX_HOME='/workspace/openclaw-codex-home'");
      expect(script).not.toContain(fakeHome);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not leave a temp guest transfer script behind when multipass is missing", async () => {
    const tempRoot = resolvePreferredOpenClawTmpDir();
    const before = new Set(fs.readdirSync(tempRoot));
    await renderPersistedGuestScript({
      outputDirName: "multipass-missing-test",
      scenarioIds: ["channel-chat-baseline"],
    });
    const added = fs.readdirSync(tempRoot).filter((entry) => !before.has(entry));
    expect(added.filter((entry) => entry.includes("-qa-suite-"))).toStrictEqual([]);
  });

  it("preserves non-install multipass probe failures", async () => {
    runExecMock.mockRejectedValueOnce(
      Object.assign(new Error("multipassd is not running"), {
        code: "EACCES",
        stdout: "",
        stderr: "multipassd is not running",
      }),
    );
    const outputDir = path.join(
      process.cwd(),
      ".artifacts",
      "qa-e2e",
      "multipass-probe-error-test",
    );
    generatedPaths.push(outputDir);

    await expect(
      runQaMultipass({
        repoRoot: process.cwd(),
        outputDir,
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).rejects.toThrow("Unable to verify Multipass availability: multipassd is not running.");
  });
});
