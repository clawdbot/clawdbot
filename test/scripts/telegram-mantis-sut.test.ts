import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCodexProxyPort,
  runSutContainerAction,
} from "../../scripts/e2e/telegram-mantis-sut.ts";
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
  it("keeps the Codex config read failure text", () => {
    const root = makeTempDir(tempDirs, "telegram-mantis-codex-home-");
    fs.mkdirSync(path.join(root, "config.toml"));

    expect(() => readCodexProxyPort(root)).toThrow(/EISDIR/u);
  });

  it("keeps stderr when a container action is terminated", () => {
    expect(() =>
      runSutContainerAction("stop", "openclaw-telegram-sut-test", "/tmp/runtime", () => ({
        signal: "SIGTERM",
        status: null,
        stderr: "permission denied while opening the Docker socket",
      })),
    ).toThrow("permission denied while opening the Docker socket");
  });

  it("releases the runtime claim before deadline-exposed removal", () => {
    const root = makeTempDir(tempDirs, "telegram-mantis-cleanup-");
    const binDir = path.join(root, "bin");
    const runtimeParent = path.join(root, "runtime");
    const runtimeRootFile = path.join(root, "runtime-root");
    const released = path.join(root, "released");
    const containerName = "openclaw-telegram-sut-dead";
    const runtimeSource = "/tmp/openclaw-tg-crabbox-sut-Dead";
    fs.mkdirSync(binDir);
    fs.mkdirSync(path.join(runtimeParent, "claims"), { recursive: true });
    fs.writeFileSync(runtimeRootFile, `${runtimeParent}\n`);
    const ownerPid = Number(
      spawnSync(
        "/bin/sh",
        [
          "-c",
          `/usr/bin/setsid /bin/bash -c ${JSON.stringify(`trap 'touch ${JSON.stringify(released)}; exit 0' TERM; touch ${JSON.stringify(path.join(root, "ready"))}; while :; do sleep 10; done`)} >/dev/null 2>&1 & pid=$!; while [ ! -e ${JSON.stringify(path.join(root, "ready"))} ]; do :; done; echo $pid`,
        ],
        { encoding: "utf8" },
      ).stdout.trim(),
    );
    const stat = fs.readFileSync(`/proc/${ownerPid}/stat`, "utf8");
    const startTime = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    const claimPath = path.join(runtimeParent, "claims", `${containerName}.claim`);
    fs.writeFileSync(claimPath, `${runtimeSource}\t${ownerPid}\t${ownerPid}\t${startTime}\n`, {
      mode: 0o400,
    });
    const docker = path.join(binDir, "docker");
    fs.writeFileSync(
      docker,
      `#!/bin/sh\ncase "$1 $2" in\n  "container ls") echo ${containerName} ;;\n  "rm --force") sleep 5; exit 1 ;;\n  "network ls") exit 0 ;;\n  *) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binDir, "install"),
      '#!/bin/bash\ndestination="${!#}"\n: >"$destination"\nchmod 0400 "$destination"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binDir, "stat"),
      `#!/bin/sh\nif [ "$1" = -c ] && [ "$2" = %u ] && [ "$3" = ${JSON.stringify(claimPath)} ]; then echo 0; else exec /usr/bin/stat "$@"; fi\n`,
      { mode: 0o755 },
    );
    const sutScript = path.join(root, "mantis-sut-container.sh");
    const source = fs
      .readFileSync("scripts/mantis/mantis-sut-container.sh", "utf8")
      .replace(
        'readonly runtime_root_file="/etc/openclaw-mantis-sut-runtime-root"',
        `readonly runtime_root_file=${JSON.stringify(runtimeRootFile)}`,
      )
      .replace(
        'readonly docker_bin="/usr/bin/docker"',
        `readonly docker_bin=${JSON.stringify(docker)}`,
      )
      .replace("--kill-after=5s 30s", "--kill-after=1s 1s");
    // A substitution that stops matching would silently point the test at the real Docker
    // binary and the real 30s deadline, so it would still pass while proving nothing.
    expect(source).toContain(runtimeRootFile);
    expect(source).toContain(docker);
    expect(source).toContain("--kill-after=1s 1s");
    fs.writeFileSync(sutScript, source, { mode: 0o755 });

    try {
      const result = spawnSync(sutScript, ["stop", containerName, runtimeSource], {
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(124);
      expect(fs.existsSync(released)).toBe(true);
    } finally {
      try {
        process.kill(-ownerPid, "SIGKILL");
      } catch {}
    }
  });

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
