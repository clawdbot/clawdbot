// Workspace provisioning covers directory-only ACP and concurrent first-turn setup.
import fs from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import * as commandExec from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import * as workspaceState from "./workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;
let disposeGitCohort: (() => Promise<void>) | undefined;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-provisioning-",
  });
});

afterEach(async () => {
  try {
    await disposeGitCohort?.();
  } finally {
    disposeGitCohort = undefined;
    closeOpenClawStateDatabaseForTest();
    resetLegacyWorkspaceStateCheckForTest();
    await testState?.cleanup();
    testState = undefined;
  }
});

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

describe("ensureAgentWorkspace runtime-managed-implicit provisioning", () => {
  it("creates only the directory for runtime-managed-implicit provisioning (#92015)", async () => {
    const tempDir = testState!.path("implicit-parent");
    const targetDir = path.join(tempDir, "implicit-acp-workspace");

    const result = await ensureAgentWorkspace({
      dir: targetDir,
      ensureBootstrapFiles: true,
      provisioning: "runtime-managed-implicit",
    });

    expect(result.dir).toBe(targetDir);
    expect(result.bootstrapPending).toBe(false);
    // Directory is provisioned so ACP cwd fallback and media staging keep working...
    await expect(fs.access(targetDir)).resolves.toBeUndefined();
    // ...but no bootstrap files, git repo, or workspace state are seeded.
    await expectPathMissing(path.join(targetDir, DEFAULT_AGENTS_FILENAME));
    await expectPathMissing(path.join(targetDir, DEFAULT_BOOTSTRAP_FILENAME));
    await expectPathMissing(path.join(targetDir, ".git"));
    expect(workspaceState.readWorkspaceStateSnapshot(targetDir).setupExists).toBe(false);
  });

  it("runtime-managed-implicit provisioning preserves pre-existing workspace content", async () => {
    const tempDir = testState!.path("implicit-parent");
    const targetDir = path.join(tempDir, "implicit-acp-workspace");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "user-notes.md"), "keep me\n");

    await ensureAgentWorkspace({
      dir: targetDir,
      ensureBootstrapFiles: true,
      provisioning: "runtime-managed-implicit",
    });

    expect(await fs.readFile(path.join(targetDir, "user-notes.md"), "utf8")).toBe("keep me\n");
    await expectPathMissing(path.join(targetDir, DEFAULT_AGENTS_FILENAME));
    await expectPathMissing(path.join(targetDir, ".git"));
  });
});

function startGitProvisioning(directories: string[], retryAfterFailure = false) {
  const dirs = directories.map((dir) => path.resolve(dir));
  const initGates = new Map(dirs.map((dir) => [dir, createDeferred()]));
  const admitted = createDeferred();
  const templates = createDeferred();
  const setup = createDeferred();
  const lateCaller = createDeferred();
  let agentsWrites = 0;
  let userWrites = 0;
  let setupWrites = 0;
  if (!retryAfterFailure) {
    lateCaller.resolve();
  }
  const realWrite = fs.writeFile.bind(fs);
  const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
    const filePath = nodeFilePath(file);
    const parent = filePath ? path.dirname(filePath) : undefined;
    const workspaceDir =
      parent && initGates.has(parent)
        ? parent
        : parent &&
            path.basename(parent).startsWith("openclaw-bootstrap-") &&
            initGates.has(path.dirname(parent))
          ? path.dirname(parent)
          : undefined;
    if (workspaceDir && filePath && path.basename(filePath) === DEFAULT_AGENTS_FILENAME) {
      if (++agentsWrites === dirs.length) {
        admitted.resolve();
      }
      // No seeding until all callers passed the real new-workspace admission.
      await admitted.promise;
    }
    try {
      return await realWrite(file, data, options);
    } finally {
      if (workspaceDir && filePath && path.basename(filePath) === DEFAULT_USER_FILENAME) {
        const last = ++userWrites === dirs.length;
        if (last) {
          templates.resolve();
        }
        // Finish real template writes before any caller can inspect customization.
        await templates.promise;
        if (last) {
          await lateCaller.promise;
        }
      }
    }
  });
  const realMerge = workspaceState.mergeWorkspaceSetupState;
  const mergeSpy = vi
    .spyOn(workspaceState, "mergeWorkspaceSetupState")
    .mockImplementation((...args) => {
      const result = realMerge(...args);
      if (initGates.has(args[0]) && ++setupWrites === dirs.length - Number(retryAfterFailure)) {
        setup.resolve();
      }
      return result;
    });
  const reads: Promise<void>[] = [];
  const realStat = fs.stat.bind(fs);
  const statSpy = vi.spyOn(fs, "stat").mockImplementation((file, options) => {
    const pending = realStat(file, options);
    if (
      typeof file === "string" &&
      path.basename(file) === ".git" &&
      initGates.has(path.dirname(file))
    ) {
      reads.push(
        pending.then(
          () => undefined,
          () => undefined,
        ),
      );
    }
    return pending;
  });
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATHEXT: process.env.PATHEXT,
    COMSPEC: process.env.COMSPEC,
    HOME: testState!.home,
    USERPROFILE: testState!.home,
    TMPDIR: testState!.root,
    TEMP: testState!.root,
    TMP: testState!.root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
  const realRun = commandExec.runCommandWithTimeout;
  const attempts: string[] = [];
  let availability: Promise<unknown> | undefined;
  const commandSpy = vi
    .spyOn(commandExec, "runCommandWithTimeout")
    .mockImplementation(async (argv, options) => {
      if (argv[0] !== "git") {
        return realRun(argv, options);
      }
      const settings = typeof options === "number" ? { timeoutMs: options } : options;
      if (argv[1] === "init") {
        const gate = settings.cwd && initGates.get(settings.cwd);
        if (!gate || !settings.cwd) {
          throw new Error("Refusing Git initialization outside the test workspace");
        }
        const fail = retryAfterFailure && attempts.length === 0;
        attempts.push(settings.cwd);
        await gate.promise;
        if (fail) {
          throw new Error("Injected Git initialization failure");
        }
      }
      const pending = realRun(argv, { ...settings, baseEnv });
      if (argv[1] === "--version") {
        availability = pending;
      }
      return pending;
    });
  const calls = directories.map((dir) => {
    const pending = ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
    void pending.catch(() => undefined);
    return pending;
  });
  disposeGitCohort = async () => {
    for (const gate of [admitted, templates, lateCaller, ...initGates.values()]) {
      gate.resolve();
    }
    await Promise.allSettled(calls);
    for (const spy of [commandSpy, statSpy, mergeSpy, writeSpy]) {
      spy.mockRestore();
    }
  };
  const waitFor = <T>(pending: PromiseLike<T>) =>
    withTestTimeout(pending, 5_000, "Workspace provisioning did not reach the held Git operation");
  return {
    calls,
    attempts,
    release: (dir: string) => initGates.get(dir)!.resolve(),
    releaseLate: () => lateCaller.resolve(),
    async ready() {
      await waitFor(setup.promise);
      // Setup publication immediately precedes Git. Drain actual metadata/probe
      // work while init is held; no guessed delay decides the dispatch count.
      await waitFor(Promise.all(reads));
      await checkpoint();
      if (availability) {
        await waitFor(availability);
      }
      await checkpoint();
    },
    async expectRepository(dir: string) {
      const result = await realRun(["git", "rev-parse", "--show-toplevel"], {
        cwd: dir,
        timeoutMs: 5_000,
        baseEnv,
      });
      expect(result.code).toBe(0);
      expect(await fs.realpath(result.stdout.trim())).toBe(await fs.realpath(dir));
    },
  };
}

describe("ensureAgentWorkspace concurrent Git initialization", () => {
  it("shares initialization for concurrent callers resolving to the same workspace", async () => {
    const dir = testState!.path("git-workspace");
    const cohort = startGitProvisioning([dir, `${dir}${path.sep}.`]);
    await cohort.ready();
    expect(cohort.attempts).toEqual([dir]);
    cohort.release(dir);
    await Promise.all(cohort.calls);
    await cohort.expectRepository(dir);
    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
    expect(cohort.attempts).toEqual([dir]);
  });

  it("lets an independent workspace finish while another initialization is held", async () => {
    const first = testState!.path("git-first");
    const second = testState!.path("git-second");
    const cohort = startGitProvisioning([first, second]);
    await cohort.ready();
    expect(cohort.attempts.toSorted()).toEqual([first, second]);
    cohort.release(second);
    await cohort.calls[1];
    await cohort.expectRepository(second);
    await expectPathMissing(path.join(first, ".git"));
    cohort.release(first);
    await cohort.calls[0];
    await cohort.expectRepository(first);
  });

  it("retries failed initialization only for a caller already admitted as brand-new", async () => {
    const dir = testState!.path("git-retry");
    const cohort = startGitProvisioning([dir, dir], true);
    await cohort.ready();
    expect(cohort.attempts).toEqual([dir]);
    cohort.release(dir);
    await Promise.race(cohort.calls);
    await expectPathMissing(path.join(dir, ".git"));
    // A newly started call sees seeded files and must not become retry-eligible.
    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
    expect(cohort.attempts).toEqual([dir]);
    cohort.releaseLate();
    await Promise.all(cohort.calls);
    expect(cohort.attempts).toEqual([dir, dir]);
    await cohort.expectRepository(dir);
  });
});
