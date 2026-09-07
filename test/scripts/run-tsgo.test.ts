// Run Tsgo tests cover run tsgo script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createSparseTsgoSkipEnv,
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "../../scripts/lib/tsgo-sparse-guard.mts";
import { resolveTsgoTimeoutMs } from "../../scripts/run-tsgo.mts";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { isProcessAlive, waitForDead, waitForPidFile } from "../helpers/process-wait.js";
import { withTestTimeout } from "../helpers/promise.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("runs the installed compiler version through the real tsgo wrapper", () => {
  const result = spawnSync(process.execPath, [path.resolve("scripts/run-tsgo.mjs"), "--version"], {
    encoding: "utf8",
    timeout: 25_000,
    killSignal: "SIGKILL",
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^Version \d/m);
}, 30_000);

it.each([false, true])(
  "refuses a shared install without creating dependency links (linked=%s)",
  (linked) => {
    const primary = fs.realpathSync.native(createTempDir("native-primary-install-"));
    const root = path.join(primary, ".claude/worktrees/validation");
    fs.mkdirSync(root, { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: primary }).status).toBe(0);
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(primary, ".git")}\n`);
    fs.writeFileSync(path.join(root, "package.json"), '{"private":true}\n');
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    fs.symlinkSync(path.resolve("node_modules"), path.join(primary, "node_modules"), "junction");
    const localModules = path.join(root, "node_modules");
    if (linked) {
      fs.symlinkSync(path.join(primary, "node_modules"), localModules, "junction");
    }
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/run-tsgo.mjs"), "--version"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Declaration input escapes checkout");
    expect(result.stderr).toContain("shared installs and external symlinks are unsupported");
    expect(fs.existsSync(localModules)).toBe(linked);
  },
);

describe("run-tsgo sparse guard", () => {
  it("ends sparse-checkout failures with the stable failure trailer", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    spawnSync("git", ["init", "-q"], { cwd });
    spawnSync("git", ["config", "core.sparseCheckout", "true"], { cwd });

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/run-tsgo.mjs"), "-p", "test/tsconfig/tsconfig.core.test.json"],
      {
        cwd,
        encoding: "utf8",
        env: process.env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
  });

  it("ignores non-core projects", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.extensions.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("ignores full worktrees", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => false,
      }),
    ).toBeNull();
  });

  it("ignores metadata-only commands", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json", "--showConfig"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("ignores sparse worktrees when the required files are present", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const requiredPaths = [
      "packages/plugin-package-contract/src/index.ts",
      "ui/config/control-ui-chunking.ts",
      "ui/src/i18n/lib/registry.ts",
      "ui/src/i18n/lib/types.ts",
      "ui/src/app/settings.ts",
      "ui/src/api/gateway.ts",
    ];

    for (const relativePath of requiredPaths) {
      const absolutePath = path.join(cwd, relativePath);
      const dir = path.dirname(absolutePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absolutePath, "", "utf8");
    }

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.other.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/packages/", "/ui/config/", "/ui/src/"],
      }),
    ).toBeNull();
  });

  it("rejects package-test sparse worktrees missing inherited declaration roots", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.test.packages.json"], {
        cwd,
        fileExists: () => true,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/packages/"],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.test.packages.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - src
      - ui/src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("rejects declaration-shard sparse worktrees missing inherited roots", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.test.extension-declarations.json"], {
        cwd,
        fileExists: () => true,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/extensions/"],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.test.extension-declarations.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - src
      - ui/src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("rejects sparse core worktrees that include only selected ui and package files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const requiredPaths = [
      "packages/plugin-package-contract/src/index.ts",
      "ui/config/control-ui-chunking.ts",
      "ui/src/i18n/lib/registry.ts",
      "ui/src/i18n/lib/types.ts",
      "ui/src/app/settings.ts",
      "ui/src/api/gateway.ts",
    ];

    for (const relativePath of requiredPaths) {
      const absolutePath = path.join(cwd, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, "", "utf8");
    }

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: [
          "/packages/plugin-package-contract/src/index.ts",
          "/ui/config/control-ui-chunking.ts",
          "/ui/src/i18n/lib/registry.ts",
          "/ui/src/i18n/lib/types.ts",
          "/ui/src/app/settings.ts",
          "/ui/src/api/gateway.ts",
        ],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.test.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - packages
      - ui/config
      - ui/src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("returns a helpful message for sparse UI worktrees missing transitive project files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const uiToolDisplay = path.join(cwd, "ui/src/lib/chat/tool-display.ts");
    fs.mkdirSync(path.dirname(uiToolDisplay), { recursive: true });
    fs.writeFileSync(uiToolDisplay, "", "utf8");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.ui.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.ui.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("rejects sparse UI worktrees missing the transitive src root", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.ui.json"], {
        cwd,
        fileExists: () => true,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/packages/", "/ui/config/", "/ui/src/"],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.ui.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it.each([
    "tsconfig.ui.json",
    "test/tsconfig/tsconfig.core.test.json",
    "test/tsconfig/tsconfig.core.test.ui-other.json",
  ])("does not require plugin browser sources for %s", (project) => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const options = {
      cwd,
      fileExists: () => true,
      isSparseCheckoutEnabled: () => true,
      sparseCheckoutPatterns: ["/packages/", "/src/", "/ui/config/", "/ui/src/"],
    };

    expect(getSparseTsgoGuardError(["-p", project], options)).toBeNull();
  });

  it("returns a helpful message for sparse core-test worktrees missing ui and packages files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.test.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - packages/plugin-package-contract/src/index.ts
      - ui/config/control-ui-chunking.ts
      - ui/src/api/gateway.ts
      - ui/src/app/settings.ts
      - ui/src/i18n/lib/registry.ts
      - ui/src/i18n/lib/types.ts
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("recognizes the check:changed sparse-skip env", () => {
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "1" })).toBe(true);
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "true" })).toBe(true);
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "0" })).toBe(false);
    expect(createSparseTsgoSkipEnv({ PATH: "/usr/bin" })).toStrictEqual({
      PATH: "/usr/bin",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
    });
  });
});

describe.skipIf(process.platform === "win32")("run-tsgo watchdog", () => {
  it("keeps the watchdog opt-in", () => {
    expect(resolveTsgoTimeoutMs({})).toBeUndefined();
    expect(resolveTsgoTimeoutMs({ OPENCLAW_TSGO_TIMEOUT_MS: "  " })).toBeUndefined();
    expect(resolveTsgoTimeoutMs({ OPENCLAW_TSGO_TIMEOUT_MS: "30000" })).toBe(30_000);
  });

  function writeFakeTsgo(cwd: string, body: string) {
    const binDir = path.join(cwd, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeTsgo = path.join(binDir, "tsgo");
    fs.writeFileSync(fakeTsgo, body, "utf8");
    fs.chmodSync(fakeTsgo, 0o755);
  }

  // The fake compiler is a grandchild in its own process group, so spawnSync's
  // killSignal never reaches it. Its recorded pid is the only handle the harness
  // has to tear the tree down when the outer timeout fires on a pre-fix run.
  function readFakeTsgoPid(cwd: string) {
    const pidFile = path.join(cwd, "fake-tsgo.pid");
    if (!fs.existsSync(pidFile)) {
      return undefined;
    }
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  }

  function reapFakeTsgo(cwd: string) {
    const pid = readFakeTsgoPid(cwd);
    if (pid === undefined) {
      return;
    }
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already reaped by the watchdog under test.
      }
    }
  }

  function withSupervisorClock(cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const preloadPath = path.join(cwd, "supervisor-clock.mjs");
    // Scale both cleanup owners so an outer cutoff that races inner reaping still fails.
    // Compiler/watchdog timers, readiness checks, and OS signals retain real time.
    fs.writeFileSync(
      preloadPath,
      `if (process.argv[1] === ${JSON.stringify(path.resolve("scripts/run-tsgo.mts"))}) {
  const realNow = Date.now.bind(Date);
  const startedAt = realNow();
  Date.now = () => startedAt + (realNow() - startedAt) * 5;
} else if (process.argv[1] === ${JSON.stringify(path.resolve("scripts/run-tsgo.mjs"))}) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay / 5, ...args);
}\n`,
    );
    return {
      ...env,
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadPath).href}`,
    };
  }

  function runFakeTsgo(
    cwd: string,
    timeoutMs: string | undefined,
    onBeforeReap?: (pid: number | undefined) => void,
  ) {
    const { OPENCLAW_TSGO_TIMEOUT_MS: _unset, ...baseEnv } = process.env;
    try {
      return spawnSync(
        process.execPath,
        [path.resolve("scripts/run-tsgo.mjs"), "-p", "tsconfig.extensions.json"],
        {
          cwd,
          encoding: "utf8",
          env: withSupervisorClock(
            cwd,
            timeoutMs === undefined ? baseEnv : { ...baseEnv, OPENCLAW_TSGO_TIMEOUT_MS: timeoutMs },
          ),
          // spawnSync blocks this thread, so vitest's own per-test budget can never
          // fire; a regression here would hang the worker instead of failing.
          timeout: 25_000,
          killSignal: "SIGKILL",
        },
      );
    } finally {
      onBeforeReap?.(readFakeTsgoPid(cwd));
      reapFakeTsgo(cwd);
    }
  }

  it("rejects and drains compiler descendants left after a successful leader exit", async () => {
    const cwd = createTempDir("openclaw-run-tsgo-lingering-");
    const descendantPidPath = path.join(cwd, "descendant.pid");
    writeFakeTsgo(
      cwd,
      `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync("fake-tsgo.pid", String(process.pid));
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
const fs = require("node:fs");
setInterval(() => {}, 1000);
fs.writeFileSync(process.argv[1], String(process.pid));
process.send("ready");
process.disconnect();
`)}, ${JSON.stringify(descendantPidPath)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", () => process.exit(0));
`,
    );
    let observedPids: Array<number | undefined> = [];
    let liveBeforeTeardown: number[] = [];
    try {
      const result = runFakeTsgo(cwd, undefined, (pid) => {
        observedPids = [
          pid,
          fs.existsSync(descendantPidPath)
            ? Number(fs.readFileSync(descendantPidPath, "utf8"))
            : undefined,
        ];
        liveBeforeTeardown = observedPids.filter(
          (owned): owned is number => owned !== undefined && isProcessAlive(owned),
        );
      });
      expect(result.error).toBeUndefined();
      expect(
        observedPids.every((pid) => pid !== undefined && Number.isSafeInteger(pid) && pid > 1),
      ).toBe(true);
      expect.soft(result.status).toBe(1);
      expect.soft(result.stderr).toContain("EPROCESSGROUP_CLEANUP_FAILED");
      expect
        .soft(liveBeforeTeardown, "compiler descendants must be absent before fixture teardown")
        .toEqual([]);
    } finally {
      for (const pidFile of [descendantPidPath, path.join(cwd, "fake-tsgo.pid")]) {
        if (!fs.existsSync(pidFile)) {
          continue;
        }
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 1) {
          continue;
        }
        if (isProcessAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
        await waitForDead(pid, 2_000);
      }
    }
  }, 30_000);

  it.each([{ bound: "0" }, { bound: "abc" }])(
    "explains a rejected OPENCLAW_TSGO_TIMEOUT_MS of $bound instead of crashing",
    ({ bound }) => {
      const cwd = createTempDir("openclaw-run-tsgo-watchdog-");
      writeFakeTsgo(cwd, "#!/bin/sh\nexit 0\n");

      const result = runFakeTsgo(cwd, bound);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be plain decimal digits");
      expect(result.stderr).toContain("Unset it to disable the watchdog");
      expect(result.stderr).not.toContain("at readPositiveEnvInt");
      expect(result.stderr.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
    },
    30_000,
  );

  it("kills a wedged tsgo that ignores SIGTERM instead of blocking its caller forever", () => {
    const cwd = createTempDir("openclaw-run-tsgo-watchdog-");
    // Mirrors the observed wedge: the checker refuses SIGTERM and never reports,
    // so only a process-group SIGKILL frees the caller. It records its pid so the
    // harness can reap the tree, and self-exits as a last-resort backstop.
    writeFakeTsgo(
      cwd,
      '#!/bin/sh\necho $$ > "$(dirname "$0")/../../fake-tsgo.pid"\ntrap \'\' TERM\ni=0\nwhile [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done\n',
    );

    const observedBeforeReap = {
      error: undefined as unknown,
      pid: undefined as number | undefined,
    };
    const result = runFakeTsgo(cwd, "2000", (pid) => {
      observedBeforeReap.pid = pid;
      if (pid === undefined) {
        return;
      }
      try {
        process.kill(pid, 0);
      } catch (error) {
        observedBeforeReap.error = error;
      }
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("killed the tsgo process tree");
    // Printing the message is not the contract; the tree actually being gone is.
    expect(observedBeforeReap.pid).toBeDefined();
    expect(observedBeforeReap.error).toMatchObject({ code: "ESRCH" });
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
  }, 30_000);

  it.each(["wrapper", "spawn"])(
    "reaps a wedged compiler on SIGTERM during %s",
    async (phase) => {
      const fixtureDirs = createTempDirTracker();
      // Detached compilers can outlive Vitest's temporary namespace. Retain their
      // diagnostics outside it until both the wrapper and compiler are joined.
      const artifacts = path.resolve(".artifacts/tsgo-signal");
      fs.mkdirSync(artifacts, { recursive: true });
      const cwd = fixtureDirs.make("fixture-", fs.realpathSync(artifacts));
      let retainFixture = false;
      try {
        const pidFile = path.join(cwd, "fake-tsgo.pid");
        // Give this fixture its own artifact lock rather than the enclosing checkout's.
        fs.writeFileSync(path.join(cwd, "package.json"), '{"private":true}\n');
        fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages: []\n");
        fs.writeFileSync(path.join(cwd, "tsconfig.extensions.json"), "{}\n");
        writeFakeTsgo(
          cwd,
          '#!/bin/sh\ntrap \'\' TERM HUP INT\necho $$ > "$(dirname "$0")/../../fake-tsgo.pid"\nwhile true; do sleep 1; done\n',
        );
        const preloadPath = path.join(cwd, "signal-during-spawn.mjs");
        // Hold the real spawn boundary until the compiler is ready, then deliver an
        // OS signal before the supervisor can register the returned child.
        fs.writeFileSync(
          preloadPath,
          `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (args[0] === ${JSON.stringify(path.join(cwd, "node_modules/.bin/tsgo"))}) {
    const pidFile = ${JSON.stringify(pidFile)};
    const deadline = performance.now() + 10_000;
    while (!fs.existsSync(pidFile) || Number(fs.readFileSync(pidFile, "utf8")) !== child.pid) {
      if (performance.now() >= deadline) throw new Error("compiler readiness timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    process.kill(process.pid, "SIGTERM");
  }
  return child;
};
syncBuiltinESMExports();
`,
        );
        const wrapper = spawn(
          process.execPath,
          [path.resolve("scripts/run-tsgo.mjs"), "-p", "tsconfig.extensions.json"],
          {
            cwd,
            stdio: ["ignore", "ignore", "pipe"],
            env: withSupervisorClock(cwd, {
              ...process.env,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""}${phase === "spawn" ? ` --import=${pathToFileURL(preloadPath).href}` : ""}`,
            }),
          },
        );
        retainFixture = true;
        const deadline = performance.now() + 15_000;
        const stderr = createBoundedChildOutput();
        wrapper.stderr.on("data", (chunk) => stderr.append(chunk));
        wrapper.once("error", (error) => stderr.append(`wrapper spawn error: ${error.message}\n`));
        // A work deadline must not consume the real completion needed by teardown.
        const wrapperClose = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve) => {
          wrapper.once("close", (code, signal) => resolve({ code, signal }));
        });
        const errors: unknown[] = [];
        try {
          const compilerPid = await waitForPidFile(pidFile, 10_000);
          if (phase === "wrapper") {
            wrapper.kill("SIGTERM");
          }

          const wrapperResult = await withTestTimeout(
            wrapperClose,
            Math.max(0, deadline - performance.now()),
            "child did not close before timeout",
          );
          expect([
            { code: 143, signal: null },
            { code: null, signal: "SIGTERM" },
          ]).toContainEqual(wrapperResult);
          await expect(waitForDead(compilerPid, 2_000)).resolves.toBeUndefined();
        } catch (error) {
          errors.push(error);
        }
        try {
          if (wrapper.exitCode === null && wrapper.signalCode === null) {
            wrapper.kill("SIGKILL");
          }
          reapFakeTsgo(cwd);
          const compilerPid = readFakeTsgoPid(cwd);
          await Promise.all([
            withTestTimeout(wrapperClose, 2_000, "wrapper did not close during cleanup"),
            compilerPid === undefined ? undefined : waitForDead(compilerPid, 2_000),
          ]);
          retainFixture = false;
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          const cause = errors.length === 1 ? errors[0] : new AggregateError(errors);
          const retained = retainFixture ? `\nfixture retained at ${cwd}` : "";
          throw new Error(
            `${errors.map(String).join("\n")}\nwrapper exitCode=${wrapper.exitCode}, signalCode=${wrapper.signalCode}${retained}\n${stderr.text()}`,
            { cause },
          );
        }
      } finally {
        if (!retainFixture) {
          fixtureDirs.cleanup();
        }
      }
    },
    20_000,
  );

  // Every bound that must leave a completing compiler alone. The ceiling case is the
  // regression that matters: without saturation Node collapses the delay to 1ms and
  // would kill this sleeping child immediately.
  it.each([
    { bound: undefined, name: "the disabled watchdog", body: "#!/bin/sh\nsleep 2\nexit 0\n" },
    { bound: "30000", name: "an explicit bound", body: "#!/bin/sh\nexit 0\n" },
    {
      bound: "2147483648",
      name: "an override past Node's timer ceiling",
      body: "#!/bin/sh\nsleep 1\nexit 0\n",
    },
  ])(
    "leaves a completing tsgo alone under $name",
    ({ bound, body }) => {
      const cwd = createTempDir("openclaw-run-tsgo-watchdog-");
      writeFakeTsgo(cwd, body);

      const result = runFakeTsgo(cwd, bound);

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("killed the tsgo process tree");
    },
    30_000,
  );
});
