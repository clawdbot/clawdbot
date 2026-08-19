import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/e2e/telegram-mantis-sut.ts";
const tempDirs: string[] = [];

function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}

afterEach(() => cleanupTempDirs(tempDirs));

describe("Telegram Mantis SUT CLI", () => {
  it("exposes only the focused start and stop contract", () => {
    const help = run(["--help"]);

    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      "start --lane <baseline|candidate> --repo-root <path> --output-dir <dir>",
    );
    expect(help.stdout).toContain("stop --session <file>");
    expect(help.stdout).not.toContain("crabbox");
  });

  it("rejects invalid lanes and missing required options before startup", () => {
    const invalidLane = run([
      "start",
      "--lane",
      "other",
      "--repo-root",
      "/tmp/repo",
      "--output-dir",
      ".artifacts/mantis-sut-test",
    ]);
    const missingRoot = run([
      "start",
      "--lane",
      "baseline",
      "--output-dir",
      ".artifacts/mantis-sut-test",
    ]);

    expect(invalidLane.status).not.toBe(0);
    expect(invalidLane.stderr).toContain("baseline");
    expect(invalidLane.stderr).toContain("candidate");
    expect(missingRoot.status).not.toBe(0);
    expect(missingRoot.stderr).toContain("--repo-root is required");
  });

  it("stops then destroys the SUT and adapts recorder artifacts for evidence", () => {
    const root = makeTempDir(tempDirs, "telegram-mantis-sut-");
    const binDir = path.join(root, "bin");
    const outputDir = path.join(root, "lane");
    const runtimeRoot = path.join(root, "runtime");
    const commandLog = path.join(root, "sudo.log");
    fs.mkdirSync(binDir);
    fs.mkdirSync(outputDir);
    fs.mkdirSync(runtimeRoot);
    const fakeSudo = path.join(binDir, "sudo");
    fs.writeFileSync(
      fakeSudo,
      `#!/bin/sh\nprintf "%s\\n" "$*" >> ${JSON.stringify(commandLog)}\n`,
      { mode: 0o755 },
    );
    const artifacts = {
      previewGifCropped: path.join(outputDir, "proof.gif"),
      screenshot: path.join(outputDir, "proof.png"),
      trimmedVideoCropped: path.join(outputDir, "proof.mp4"),
    };
    for (const artifact of Object.values(artifacts)) {
      fs.writeFileSync(artifact, "evidence");
    }
    for (const name of ["gateway.log", "mock-openai.log", "mock-openai-requests.ndjson"]) {
      fs.writeFileSync(path.join(runtimeRoot, name), name);
    }
    fs.writeFileSync(
      path.join(outputDir, "recorder.json"),
      `${JSON.stringify({ artifacts, stoppedAt: new Date().toISOString() })}\n`,
    );
    const sessionPath = path.join(outputDir, "sut.json");
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        command: "telegram-mantis-sut-session",
        createdAt: new Date().toISOString(),
        outputDir,
        runtime: {
          configPath: path.join(runtimeRoot, "openclaw.json"),
          containerName: "openclaw-telegram-sut-test",
          gatewayLog: path.join(runtimeRoot, "gateway.log"),
          gatewayPid: 123,
          mockLog: path.join(runtimeRoot, "mock-openai.log"),
          mockPid: 123,
          requestLog: path.join(runtimeRoot, "mock-openai-requests.ndjson"),
          stateDir: path.join(runtimeRoot, "state"),
          sutAttestation: { lane: "baseline", sha: "a".repeat(40) },
          tempRoot: runtimeRoot,
          workspace: path.join(runtimeRoot, "workspace"),
        },
        schemaVersion: 1,
        telegram: { botToken: "secret-token", chat: "-100123456789" },
      })}\n`,
      { mode: 0o600 },
    );

    const result = run(["stop", "--session", sessionPath], {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(sessionPath)).toBe(false);
    const commands = fs.readFileSync(commandLog, "utf8").trim().split("\n");
    expect(commands[0]).toContain(" stop ");
    expect(commands[1]).toContain(" destroy ");
    const summary = JSON.parse(
      fs.readFileSync(path.join(outputDir, "telegram-user-crabbox-session-summary.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      artifacts,
      status: "pass",
      sutAttestation: { lane: "baseline", sha: "a".repeat(40) },
    });
  });
});
