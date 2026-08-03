import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGlobalRuntimeDotEnvFiles, readDotEnvFile } from "./dotenv-global.js";

const logWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: logWarnSpy }),
}));

const cleanups: Array<() => void> = [];

afterEach(() => {
  logWarnSpy.mockClear();
  for (const fn of cleanups.splice(0)) {
    fn();
  }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "openclaw-dotenv-global-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function tmpFile(name: string, contents: string): string {
  const d = tmpDir();
  const p = join(d, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("readDotEnvFile", () => {
  it("reads a small .env file", () => {
    const filePath = tmpFile(".env", "API_KEY=secret\nOTHER_KEY=value\n");
    const result = readDotEnvFile({ filePath });
    expect(result).not.toBeNull();
    expect(result!.entries).toContainEqual({ key: "API_KEY", value: "secret" });
    expect(result!.entries).toContainEqual({ key: "OTHER_KEY", value: "value" });
    expect(logWarnSpy).not.toHaveBeenCalled();
  });

  it("reads a symlinked .env file", () => {
    const d = tmpDir();
    const realPath = join(d, "real.env");
    writeFileSync(realPath, "REAL_KEY=from_symlink_target\n", "utf8");
    const linkPath = join(d, ".env");
    symlinkSync(realPath, linkPath);
    const result = readDotEnvFile({ filePath: linkPath });
    expect(result).not.toBeNull();
    expect(result!.entries).toContainEqual({
      key: "REAL_KEY",
      value: "from_symlink_target",
    });
  });

  it("returns null for a missing file (quiet)", () => {
    const d = tmpDir();
    const result = readDotEnvFile({ filePath: join(d, "nonexistent.env"), quiet: true });
    expect(result).toBeNull();
    expect(logWarnSpy).not.toHaveBeenCalled();
  });

  it("warns when an oversized .env file is skipped", () => {
    const d = tmpDir();
    // Create a file larger than 1 MiB so the bounded read rejects it.
    const filePath = join(d, "oversized.env");
    const large = Buffer.alloc(2 * 1024 * 1024, "x");
    large.write("KEY=value\n", 0, "utf8");
    writeFileSync(filePath, large);
    const result = readDotEnvFile({ filePath, quiet: false });
    expect(result).toBeNull();
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipping oversized .env file (max"),
    );
  });
});

describe("loadGlobalRuntimeDotEnvFiles", () => {
  it("loads env vars from gateway.systemd.env and node.systemd.env", () => {
    const d = tmpDir();
    const stateEnvPath = join(d, ".env");
    writeFileSync(stateEnvPath, "ONLY_IN_DOTENV=from-dotenv\n", "utf8");
    writeFileSync(
      join(d, "gateway.systemd.env"),
      "GATEWAY_SYSTEMD_VAR=from-gateway-systemd\n",
      "utf8",
    );
    writeFileSync(join(d, "node.systemd.env"), "NODE_SYSTEMD_VAR=from-node-systemd\n", "utf8");

    const savedEnvKeys = new Set(["ONLY_IN_DOTENV", "GATEWAY_SYSTEMD_VAR", "NODE_SYSTEMD_VAR"]);
    const savedEnv: Record<string, string | undefined> = {};
    try {
      for (const key of savedEnvKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }

      const result = loadGlobalRuntimeDotEnvFiles({
        stateEnvPath,
        quiet: true,
      });

      expect(process.env.ONLY_IN_DOTENV).toBe("from-dotenv");
      expect(process.env.GATEWAY_SYSTEMD_VAR).toBe("from-gateway-systemd");
      expect(process.env.NODE_SYSTEMD_VAR).toBe("from-node-systemd");

      const allApplied = [...(result?.stateEnvAppliedKeys ?? [])];
      expect(allApplied).toContain("ONLY_IN_DOTENV");
    } finally {
      for (const key of savedEnvKeys) {
        if (savedEnv[key] !== undefined) {
          process.env[key] = savedEnv[key];
        } else {
          delete process.env[key];
        }
      }
    }
  });

  it("does not override existing env vars from systemd env files", () => {
    const d = tmpDir();
    const stateEnvPath = join(d, ".env");
    writeFileSync(stateEnvPath, "", "utf8");
    writeFileSync(join(d, "gateway.systemd.env"), "EXISTING_VAR=from-systemd\n", "utf8");

    const saved = process.env.EXISTING_VAR;
    try {
      process.env.EXISTING_VAR = "already-set";

      loadGlobalRuntimeDotEnvFiles({
        stateEnvPath,
        quiet: true,
      });

      // Should not override the existing value.
      expect(process.env.EXISTING_VAR).toBe("already-set");
    } finally {
      if (saved !== undefined) {
        process.env[saved] = saved;
      } else {
        delete process.env.EXISTING_VAR;
      }
    }
  });
});
