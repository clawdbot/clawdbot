import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runContract(help: string) {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "openclaw-clawhub-contract-"));
  const fixturePath = path.join(fixtureDir, "clawhub");
  try {
    writeFileSync(fixturePath, `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(help)}\n`);
    chmodSync(fixturePath, 0o755);
    return spawnSync("bash", ["scripts/verify-clawhub-cli-contract.sh", fixturePath], {
      encoding: "utf8",
    });
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
}

describe("ClawHub CLI command contract", () => {
  it("accepts the trusted-publisher command with required flags", () => {
    const result = runContract(
      "Usage: clawhub package trusted-publisher set\n--repository\n--workflow-filename",
    );

    expect(result.status).toBe(0);
  });

  it("rejects a CLI that drops a required flag", () => {
    const result = runContract("Usage: clawhub package trusted-publisher set\n--repository");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--workflow-filename");
  });
});
