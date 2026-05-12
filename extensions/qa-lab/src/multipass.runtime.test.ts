import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

function readRootPackageManager() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  ) as {
    packageManager?: string;
  };
  return packageJson.packageManager;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: execFileMock,
  };
});

import {
  createQaMultipassPlan,
  renderQaMultipassGuestScript,
  runQaMultipass,
} from "./multipass.runtime.js";

describe("qa multipass runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects output directories outside the mounted repo root", () => {
    expect(() =>
      createQaMultipassPlan({
        repoRoot: process.cwd(),
        outputDir: "/tmp/qa-out",
      }),
    ).toThrow("qa suite --runner multipass requires --output-dir to stay under the repo root");
  });

  it("rejects repo-local symlink output directories that escape the repo root", () => {
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
      expect(() =>
        createQaMultipassPlan({
          repoRoot,
          outputDir: path.join(symlinkPath, "qa-out"),
        }),
      ).toThrow("qa suite --runner multipass requires --output-dir to stay under the repo root");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reuses suite scenario semantics and resolves mounted artifact paths", () => {
    const repoRoot = process.cwd();
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "multipass-test");
    const plan = createQaMultipassPlan({
      repoRoot,
      outputDir,
    });

    expect(plan.outputDir).toBe(outputDir);
    expect(plan.scenarioIds).toStrictEqual([]);
    expect(plan.qaCommand).not.toContain("--scenario");
    expect(plan.guestOutputDir).toBe("/workspace/openclaw-host/.artifacts/qa-e2e/multipass-test");
    expect(plan.reportPath).toBe(path.join(outputDir, "qa-suite-report.md"));
    expect(plan.summaryPath).toBe(path.join(outputDir, "qa-suite-summary.json"));
  });

  it("renders a guest script that runs the live qa suite by default", () => {
    const plan = createQaMultipassPlan({
      repoRoot: process.cwd(),
      outputDir: path.join(process.cwd(), ".artifacts", "qa-e2e", "multipass-test"),
      scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
    });

    const script = renderQaMultipassGuestScript(plan);

    expect(script).toContain("pnpm install --frozen-lockfile");
    expect(script).toContain("pnpm build");
    expect(script).toContain(`corepack prepare '${readRootPackageManager()}' --activate`);
    expect(script).toContain("'pnpm' 'openclaw' 'qa' 'suite' '--transport' 'qa-channel'");
    expect(script).toContain("'--provider-mode' 'live-frontier'");
    expect(script).toContain("'--scenario' 'channel-chat-baseline'");
    expect(script).toContain("'--scenario' 'thread-follow-up'");
    expect(script).toContain("/workspace/openclaw-host/.artifacts/qa-e2e/multipass-test");
  });

  it("carries live suite flags and forwarded auth env into the guest command", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const plan = createQaMultipassPlan({
      repoRoot: process.cwd(),
      outputDir: path.join(process.cwd(), ".artifacts", "qa-e2e", "multipass-live-test"),
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5",
      fastMode: true,
      scenarioIds: ["channel-chat-baseline"],
    });

    const script = renderQaMultipassGuestScript(plan);

    expect(plan.qaCommand).toContain("--provider-mode");
    expect(plan.qaCommand).toContain("live-frontier");
    expect(plan.qaCommand).toContain("--model");
    expect(plan.qaCommand).toContain("openai/gpt-5.5");
    expect(plan.qaCommand).toContain("--alt-model");
    expect(plan.qaCommand).toContain("--fast");
    expect(plan.forwardedEnv.OPENAI_API_KEY).toBe("test-openai-key");
    expect(script).toContain("OPENAI_API_KEY='test-openai-key'");
    expect(script).toContain("'pnpm' 'openclaw' 'qa' 'suite' '--transport' 'qa-channel'");
    expect(script).toContain("'--provider-mode' 'live-frontier'");
  });

  it("forwards --allow-failures into the guest qa suite command when requested", () => {
    const plan = createQaMultipassPlan({
      repoRoot: process.cwd(),
      outputDir: path.join(process.cwd(), ".artifacts", "qa-e2e", "multipass-allow-failures-test"),
      allowFailures: true,
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(plan.qaCommand).toContain("--allow-failures");
  });

  it("redacts forwarded live secrets in the persisted artifact script", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const plan = createQaMultipassPlan({
      repoRoot: process.cwd(),
      outputDir: path.join(process.cwd(), ".artifacts", "qa-e2e", "multipass-live-test"),
      providerMode: "live-frontier",
      scenarioIds: ["channel-chat-baseline"],
    });

    const redactedScript = renderQaMultipassGuestScript(plan, { redactSecrets: true });

    expect(redactedScript).toContain("OPENAI_API_KEY='<redacted>'");
    expect(redactedScript).not.toContain("OPENAI_API_KEY='test-openai-key'");
  });

  it("forwards live key list and numbered key env shapes", () => {
    vi.stubEnv("OPENCLAW_LIVE_ANTHROPIC_KEYS", "anthropic-a anthropic-b");
    vi.stubEnv("OPENAI_API_KEY_1", "openai-one");
    vi.stubEnv("GEMINI_API_KEY_2", "gemini-two");
    const plan = createQaMultipassPlan({
      repoRoot: process.cwd(),
      outputDir: path.join(process.cwd(), ".artifacts", "qa-e2e", "multipass-live-test"),
      providerMode: "live-frontier",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(plan.forwardedEnv.OPENCLAW_LIVE_ANTHROPIC_KEYS).toBe("anthropic-a anthropic-b");
    expect(plan.forwardedEnv.OPENAI_API_KEY_1).toBe("openai-one");
    expect(plan.forwardedEnv.GEMINI_API_KEY_2).toBe("gemini-two");
  });

  it("skips stale CODEX_HOME values that do not exist on the host", () => {
    vi.stubEnv("CODEX_HOME", "/tmp/does-not-exist-openclaw-codex-home");
    const plan = createQaMultipassPlan({
      repoRoot: process.cwd(),
      outputDir: path.join(process.cwd(), ".artifacts", "qa-e2e", "multipass-live-test"),
      providerMode: "live-frontier",
    });

    expect(plan.forwardedEnv.CODEX_HOME).toBeUndefined();
    expect(plan.hostCodexHomePath).toBeUndefined();
    expect(plan.guestCodexHomePath).toBeUndefined();
  });

  it("falls back to os.homedir() when HOME is unset for CODEX_HOME discovery", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-multipass-home-"));
    const fakeHome = path.join(tempRoot, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    fs.mkdirSync(fakeCodexHome, { recursive: true });
    vi.stubEnv("HOME", "");
    vi.stubEnv("CODEX_HOME", "");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    try {
      const plan = createQaMultipassPlan({
        repoRoot: process.cwd(),
        outputDir: path.join(process.cwd(), ".artifacts", "qa-e2e", "multipass-live-test"),
        providerMode: "live-frontier",
      });

      expect(plan.forwardedEnv.CODEX_HOME).toBe(fakeCodexHome);
      expect(plan.hostCodexHomePath).toBe(fakeCodexHome);
      expect(plan.guestCodexHomePath).toBe("/workspace/openclaw-codex-home");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not leave a temp guest transfer script behind when multipass is missing", async () => {
    const outputDir = path.join(process.cwd(), ".artifacts", "qa-e2e", "multipass-missing-test");
    vi.spyOn(Date, "now").mockReturnValue(1_717_171_717_171);
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);
    (execFileMock as unknown as Mock).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      const error = new Error("spawn multipass ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      callback(error, "", "");
    });

    const expectedVmName = createQaMultipassPlan({
      repoRoot: process.cwd(),
      outputDir,
      scenarioIds: ["channel-chat-baseline"],
    }).vmName;
    const expectedTransferDir = path.join(
      resolvePreferredOpenClawTmpDir(),
      `${expectedVmName}-qa-suite-`,
    );

    await expect(
      runQaMultipass({
        repoRoot: process.cwd(),
        outputDir,
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).rejects.toThrow("Multipass is not installed on this host.");

    const tempEntries = fs
      .readdirSync(resolvePreferredOpenClawTmpDir())
      .filter((entry) => entry.startsWith(path.basename(expectedTransferDir)));
    expect(tempEntries).toStrictEqual([]);
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("preserves non-install multipass probe failures", async () => {
    const outputDir = path.join(
      process.cwd(),
      ".artifacts",
      "qa-e2e",
      "multipass-probe-error-test",
    );
    (execFileMock as unknown as Mock).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      const error = new Error("multipassd is not running") as NodeJS.ErrnoException;
      error.code = "EACCES";
      callback(error, "", "multipassd is not running");
    });

    await expect(
      runQaMultipass({
        repoRoot: process.cwd(),
        outputDir,
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).rejects.toThrow("Unable to verify Multipass availability: multipassd is not running.");

    fs.rmSync(outputDir, { recursive: true, force: true });
  });
});
