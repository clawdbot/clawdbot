// Run Tsgo tests cover run tsgo script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSparseTsgoSkipEnv,
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "../../scripts/lib/tsgo-sparse-guard.mts";
import { resolveTsgoTimeoutMs } from "../../scripts/run-tsgo.mts";
import { waitForChildClose, waitForDead, waitForPidFile } from "../helpers/process-wait.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

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
          env:
            timeoutMs === undefined ? baseEnv : { ...baseEnv, OPENCLAW_TSGO_TIMEOUT_MS: timeoutMs },
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

  it("lets the inner supervisor reap a wedged compiler before the wrapper exits on SIGTERM", async () => {
    const cwd = createTempDir("openclaw-run-tsgo-signal-");
    const pidFile = path.join(cwd, "fake-tsgo.pid");
    fs.writeFileSync(path.join(cwd, "tsconfig.extensions.json"), "{}\n");
    writeFakeTsgo(
      cwd,
      '#!/bin/sh\necho $$ > "$(dirname "$0")/../../fake-tsgo.pid"\ntrap \'\' TERM HUP INT\nwhile true; do sleep 1; done\n',
    );
    const wrapper = spawn(
      process.execPath,
      [path.resolve("scripts/run-tsgo.mjs"), "-p", "tsconfig.extensions.json"],
      { cwd, stdio: "ignore" },
    );

    try {
      const compilerPid = await waitForPidFile(pidFile, 10_000);
      wrapper.kill("SIGTERM");

      await expect(waitForChildClose(wrapper, 15_000)).resolves.toEqual({
        code: 143,
        signal: null,
      });
      await expect(waitForDead(compilerPid, 2_000)).resolves.toBeUndefined();
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill("SIGKILL");
      }
      reapFakeTsgo(cwd);
    }
  }, 20_000);

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
