import { spawnSync } from "node:child_process";
// Proxy CA installer tests keep macOS trust changes behind explicit CLI args.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/proxy-install-ca.mjs";
const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function runProxyInstallCa(args: string[], certDir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_DEBUG_PROXY_CERT_DIR: certDir,
    },
  });
}

describe("scripts/proxy-install-ca.mjs", () => {
  it("rejects unknown arguments before creating the debug proxy CA", () => {
    const root = makeTempDir(tempDirs, "openclaw-proxy-install-ca-");
    const certDir = join(root, "certs");
    const result = runProxyInstallCa(["--print-onli"], certDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown proxy install CA argument: --print-onli");
    expect(result.stderr).toContain(
      "Usage: node --import tsx scripts/proxy-install-ca.mjs [--print-only]",
    );
    expect(result.stdout).toBe("");
    expect(existsSync(certDir)).toBe(false);
  });

  it("prints usage without creating the debug proxy CA", () => {
    const root = makeTempDir(tempDirs, "openclaw-proxy-install-ca-");
    const certDir = join(root, "certs");
    const result = runProxyInstallCa(["--help"], certDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/proxy-install-ca.mjs [--print-only]",
    );
    expect(result.stderr).toBe("");
    expect(existsSync(certDir)).toBe(false);
  });
});
