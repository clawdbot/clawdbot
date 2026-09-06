import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import * as exec from "../process/exec.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { prepareUpdateFailureTriage, runUpdateFailureTriage } from "./update-triage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function createInstalledTriage(params: { hang?: boolean; promptPath?: string } = {}) {
  const root = await fs.realpath(tempDirs.make("openclaw-triage-child-"));
  const receiptPath = path.join(root, "receipt.json");
  const promptPath = params.promptPath ?? path.join(root, "triage-prompt.md");
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "dist", "index.js"),
    `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ pid: process.pid, updateRunId: process.env[${JSON.stringify(UPDATE_RUN_ID_ENV)}] ?? null }));
    ${params.hang ? "setInterval(() => {}, 1000);" : `process.stdout.write(JSON.stringify({ promptPath: ${JSON.stringify(promptPath)}, bundlePath: null, bundleError: "Snapshot unavailable" }));`}
  `,
  );
  return {
    receiptPath,
    promptPath,
    target: {
      root,
      nodeRunner: process.execPath,
      env: { HOME: root, USERPROFILE: root, OPENCLAW_STATE_DIR: path.join(root, "state") },
    },
  };
}

describe("update triage child lifecycle", () => {
  it.each(["abort", "owner closure"] as const)(
    "does not start prepared interactive triage after %s during cwd validation",
    async (closure) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const triage = await import("../commands/triage.js");
        const handoff = vi.spyOn(triage, "triageCommand").mockResolvedValue();
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const prepared = await prepareUpdateFailureTriage({
          mode: "interactive",
          runtime,
          invocationCwd: state.workspaceDir,
        });
        const cwdStat = await fs.stat(state.workspaceDir);
        let release!: () => void;
        let started!: () => void;
        const validating = new Promise<void>((resolve) => {
          started = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        vi.spyOn(fs, "stat").mockImplementationOnce(async () => {
          started();
          await blocked;
          return cwdStat;
        });
        const controller = new AbortController();
        let current = true;
        const pending = prepared({
          failure: { error: "Update failed" },
          target: { env: { ...process.env } },
          signal: controller.signal,
          isCurrent: () => current,
        });
        await validating;
        if (closure === "abort") {
          controller.abort();
        } else {
          current = false;
        }
        release();
        expect(await pending).toEqual({ status: "cancelled" });
        expect(handoff).not.toHaveBeenCalled();
        expect(runtime.error).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps artifact paths in local output and returns the partial-export outcome", async () => {
    const { target, promptPath } = await createInstalledTriage();
    const runtime = { log: vi.fn(), error: vi.fn() };
    const result = await runUpdateFailureTriage({
      failure: { error: "Update could not install the package" },
      target,
      mode: "json",
      runtime,
    });
    expect(result).toMatchObject({
      status: "completed",
      contextPath: expect.any(String),
      hint: expect.stringContaining("Diagnostics export unavailable: Snapshot unavailable"),
    });
    expect("hint" in result && result.hint).not.toContain(target.root);
    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify({ promptPath, bundlePath: null, bundleError: "Snapshot unavailable" }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("does not lend the completed update run identity to fresh triage", async () => {
    const { target, receiptPath } = await createInstalledTriage();
    const result = await runUpdateFailureTriage({
      failure: { error: "Update failed" },
      target: { ...target, env: { ...target.env, [UPDATE_RUN_ID_ENV]: "completed-update-run" } },
      mode: "json",
      runtime: { log: vi.fn(), error: vi.fn() },
    });
    expect(result.status).toBe("completed");
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject({ updateRunId: null });
  });

  it("does not launch diagnostics after its owner closes during root discovery", async () => {
    const { target, receiptPath } = await createInstalledTriage();
    let releaseRoot!: (root: string) => void;
    let started!: () => void;
    const discovering = new Promise<void>((resolve) => {
      started = resolve;
    });
    let current = true;
    const pending = runUpdateFailureTriage({
      failure: { error: "Update failed" },
      target: { ...target, root: undefined },
      resolveRoot: () =>
        new Promise((resolve) => {
          releaseRoot = resolve;
          started();
        }),
      mode: "json",
      runtime: { log: vi.fn(), error: vi.fn() },
      isCurrent: () => current,
    });
    await discovering;
    current = false;
    releaseRoot(target.root);
    expect(await pending).toEqual({ status: "cancelled" });
    await expect(fs.stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("terminates diagnostics and suppresses publication when its scheduler stops", async () => {
    const { target, receiptPath } = await createInstalledTriage({ hang: true });
    const controller = new AbortController();
    const runtime = { log: vi.fn(), error: vi.fn() };
    const pending = runUpdateFailureTriage({
      failure: { error: "Update failed" },
      target,
      mode: "json",
      runtime,
      signal: controller.signal,
    });
    try {
      await expect
        .poll(() => fs.readFile(receiptPath, "utf8").catch(() => ""), { timeout: 5000 })
        .not.toBe("");
      const { pid } = JSON.parse(await fs.readFile(receiptPath, "utf8")) as { pid: number };
      controller.abort();
      expect(await pending).toEqual({ status: "cancelled" });
      await expect.poll(() => isPidAlive(pid)).toBe(false);
      expect(runtime.log).toHaveBeenCalledExactlyOnceWith("Update failed. Entering triage...");
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await pending;
    }
  });

  it.each(["timeout", "signal"] as const)(
    "does not complete when a %s child exits gracefully with code zero",
    async (termination) => {
      const { target, promptPath } = await createInstalledTriage();
      vi.spyOn(exec, "runCommandWithTimeout").mockResolvedValueOnce({
        stdout: JSON.stringify({ promptPath }),
        stderr: "",
        code: 0,
        signal: null,
        killed: true,
        termination,
      });
      const result = await runUpdateFailureTriage({
        failure: { error: "Update failed" },
        target,
        mode: "json",
        runtime: { log: vi.fn(), error: vi.fn() },
      });
      expect(result).toMatchObject({
        status: "failed",
        hint: expect.stringContaining(`Triage stopped (${termination})`),
      });
    },
  );

  it.each([
    { name: "empty", promptPath: "" },
    { name: "oversized", promptPath: "x".repeat(4097) },
  ])("rejects $name report paths", async ({ promptPath }) => {
    const { target } = await createInstalledTriage({ promptPath });
    const result = await runUpdateFailureTriage({
      failure: { error: "Update failed" },
      target,
      mode: "json",
      runtime: { log: vi.fn(), error: vi.fn() },
    });
    expect(result).toMatchObject({
      status: "failed",
      hint: expect.stringContaining("openclaw triage"),
    });
  });

  it.each(["linux", "win32"] as const)(
    "keeps a bounded diagnostic failure cause with an executable %s host command",
    async (platformName) => {
      const { target } = await createInstalledTriage();
      vi.spyOn(process, "platform", "get").mockReturnValue(platformName);
      target.env.OPENCLAW_STATE_DIR = path.join(target.root, "state directory's");
      const configPath = path.join(target.root, "custom config.json");
      const workspaceDir = path.join(target.root, "custom workspace");
      const targetEnv = {
        ...target.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_WORKSPACE_DIR: workspaceDir,
      };
      const credential = "synthetic-triage-bearer-value";
      vi.spyOn(exec, "runCommandWithTimeout").mockRejectedValueOnce(
        new Error(`ENOSPC Authorization: Bearer ${credential}\n${"detail ".repeat(1000)}`),
      );
      const runtime = { log: vi.fn(), error: vi.fn() };
      const result = await runUpdateFailureTriage({
        failure: { error: "Update failed" },
        target: { ...target, env: targetEnv },
        mode: "json",
        runtime,
      });
      expect(result).toMatchObject({ status: "failed", hint: expect.stringContaining("ENOSPC") });
      expect(JSON.stringify(result)).not.toContain(credential);
      if (result.status === "failed") {
        const guidance = runtime.log.mock.calls.flat().join("\n");
        expect(result.hint).not.toContain(target.root);
        expect(result.hint.split("\n")[0]?.length).toBeLessThan(284);
        expect(result.contextPath).toEqual(expect.any(String));
        if (platformName === "win32") {
          expect(guidance).toContain(
            `& openclaw triage --update-result '${result.contextPath!.replaceAll("'", "''")}'`,
          );
          for (const selector of [targetEnv.OPENCLAW_STATE_DIR, configPath, workspaceDir]) {
            expect(guidance).toContain(`'${selector.replaceAll("'", "''")}'`);
          }
        } else {
          expect(guidance).toContain(`--update-result ${quoteCliArg(result.contextPath!)}`);
          expect(guidance).toContain(
            `OPENCLAW_STATE_DIR=${quoteCliArg(targetEnv.OPENCLAW_STATE_DIR)}`,
          );
          expect(guidance).toContain(`OPENCLAW_CONFIG_PATH=${quoteCliArg(configPath)}`);
          expect(guidance).toContain(`OPENCLAW_WORKSPACE_DIR=${quoteCliArg(workspaceDir)}`);
        }
        await expect(fs.stat(result.contextPath!)).resolves.toMatchObject({
          size: expect.any(Number),
        });
      }
    },
  );
});
