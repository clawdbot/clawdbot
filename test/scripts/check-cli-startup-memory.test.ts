// Check Cli Startup Memory tests cover check cli startup memory script behavior.
import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/check-cli-startup-memory.mjs";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-startup-memory-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-cli-startup-memory", () => {
  it("resolves the repository root from the script location", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const scriptUrl = pathToFileURL(path.join(repoRoot, "scripts/check-cli-startup-memory.mjs"));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const mod = await import(${JSON.stringify(scriptUrl.href)}); console.log(mod.testing.repoRoot);`,
      ],
      {
        cwd: path.join(repoRoot, "test/scripts"),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(repoRoot);
  });

  it("keeps the Linux help startup budget tight while allowing macOS RSS overhead", () => {
    expect(testing.resolveDefaultLimitsMb("linux").help).toBe(100);
    expect(testing.resolveDefaultLimitsMb("darwin").help).toBeGreaterThan(100);
  });

  it("keeps invalid startup memory env values from bypassing budgets", () => {
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "abc",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "1e3",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "0x10",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "0",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "125.5",
      }),
    ).toBe(125.5);
  });

  it("keeps invalid startup memory timeout env values from parsing loosely", () => {
    expect(() =>
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS must be a positive number");
    expect(() =>
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: "1000.5",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS must be a positive integer");
    expect(
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: "1000",
      }),
    ).toBe(1000);
  });

  it("rejects missing startup memory artifact paths", () => {
    for (const args of [
      ["--json"],
      ["--json", "--summary"],
      ["--summary"],
      ["--summary", "--json"],
    ]) {
      expect(() => testing.parseArgs(args)).toThrow(/--(?:json|summary) requires a path/u);
    }
  });

  it("does not create a temp home before argument validation succeeds", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = makeTempRoot();
    const result = spawnSync(process.execPath, ["scripts/check-cli-startup-memory.mjs", "--json"], {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: tempRoot,
        TEMP: tempRoot,
        TMP: tempRoot,
      },
    });

    expect(result.status).not.toBe(0);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("times out startup probes instead of hanging indefinitely", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = makeTempRoot();
    const seenTimeouts: Array<number | undefined> = [];
    const seenKillSignals: Array<string | undefined> = [];
    const timeoutError = Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" });

    expect(() =>
      testing.runStartupMemoryCheck(
        [
          "--json",
          path.join(tempRoot, "startup-memory.json"),
          "--summary",
          path.join(tempRoot, "summary.md"),
        ],
        {
          platform: "linux",
          timeoutMs: 1234,
          spawnSync: (
            _command: string,
            _args: string[],
            options: { killSignal?: string; timeout?: number },
          ) => {
            seenTimeouts.push(options.timeout);
            seenKillSignals.push(options.killSignal);
            return {
              error: timeoutError,
              signal: "SIGKILL",
              status: null,
              stderr: "",
              stdout: "",
            };
          },
        },
      ),
    ).toThrow("--help timed out after 1234ms");
    expect(seenTimeouts).toEqual([1234, 1234, 1234]);
    expect(seenKillSignals).toEqual(["SIGKILL", "SIGKILL", "SIGKILL"]);
  });

  it("rejects zero RSS markers instead of passing empty resource evidence", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = makeTempRoot();
    expect(() =>
      testing.runStartupMemoryCheck(
        [
          "--json",
          path.join(tempRoot, "startup-memory.json"),
          "--summary",
          path.join(tempRoot, "summary.md"),
        ],
        {
          platform: "darwin",
          spawnSync: () => ({
            signal: null,
            status: 0,
            stderr: "__OPENCLAW_MAX_RSS_KB__=0\n",
            stdout: "",
          }),
        },
      ),
    ).toThrow("--help did not report max RSS");
  });
});
