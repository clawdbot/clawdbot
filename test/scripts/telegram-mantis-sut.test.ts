import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runSutContainerAction,
  waitForLog,
  writeSutConfig,
} from "../../scripts/e2e/telegram-mantis-sut.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sutSupervisorCommand(): string {
  const source = fs.readFileSync("scripts/mantis/mantis-sut-container.sh", "utf8");
  const match = source.match(/readonly sut_command='([\s\S]*?)'\n\nrequire_active_sut\(\)/u);
  if (!match?.[1]) {
    throw new Error("Could not extract the SUT gateway supervisor.");
  }
  return match[1];
}

describe("Telegram Mantis SUT", () => {
  it("keeps stderr when a container action is terminated", () => {
    expect(() =>
      runSutContainerAction("stop", "openclaw-telegram-sut-test", "/tmp/runtime", () => ({
        signal: "SIGTERM",
        status: null,
        stderr: "permission denied while opening the Docker socket",
      })),
    ).toThrow("permission denied while opening the Docker socket");
  });

  it("reports a silent container daemon exit instead of a mock-openai timeout", async () => {
    const root = tempDirs.make("telegram-mantis-start-failure-");
    const mockLog = path.join(root, "mock-openai.log");
    const daemonLog = path.join(root, "sut-container.log");
    fs.writeFileSync(mockLog, "");
    fs.writeFileSync(daemonLog, "");
    const child = spawn(process.execPath, ["-e", "process.exit(23)"], { stdio: "ignore" });

    await expect(
      waitForLog(mockLog, /mock-openai listening/u, "mock-openai", 30_000, {
        daemon: { child },
        logPath: daemonLog,
      }),
    ).rejects.toThrow(
      "Container-isolated SUT exited with exit code 23 before mock-openai became ready.\nsut-container.log: <empty>",
    );
  }, 40_000);

  it("releases the runtime claim before deadline-exposed removal", () => {
    const root = tempDirs.make("telegram-mantis-cleanup-");
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

  it("waits for the claimed runtime owner before returning from stop", () => {
    const root = tempDirs.make("telegram-mantis-stop-sync-");
    const binDir = path.join(root, "bin");
    const runtimeParent = path.join(root, "runtime");
    const runtimeRootFile = path.join(root, "runtime-root");
    const released = path.join(root, "released");
    const containerName = "openclaw-telegram-sut-feed";
    const runtimeSource = "/tmp/openclaw-tg-crabbox-sut-Sync";
    fs.mkdirSync(binDir);
    fs.mkdirSync(path.join(runtimeParent, "claims"), { recursive: true });
    fs.writeFileSync(runtimeRootFile, `${runtimeParent}\n`);
    const ownerPid = Number(
      spawnSync(
        "/bin/sh",
        [
          "-c",
          `/usr/bin/setsid /bin/bash -c ${JSON.stringify(`trap 'sleep 1; touch ${JSON.stringify(released)}; exit 0' TERM; touch ${JSON.stringify(path.join(root, "ready"))}; while :; do sleep 10; done`)} >/dev/null 2>&1 & pid=$!; while [ ! -e ${JSON.stringify(path.join(root, "ready"))} ]; do :; done; echo $pid`,
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
      '#!/bin/sh\ncase "$1 $2" in\n  "container ls"|"network ls") exit 0 ;;\n  *) exit 1 ;;\nesac\n',
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
      );
    expect(source).toContain(runtimeRootFile);
    expect(source).toContain(docker);
    fs.writeFileSync(sutScript, source, { mode: 0o755 });

    try {
      const result = spawnSync(sutScript, ["stop", containerName, runtimeSource], {
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      });
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(fs.existsSync(released)).toBe(true);
    } finally {
      try {
        process.kill(-ownerPid, "SIGKILL");
      } catch {}
    }
  });

  it("relaunches the gateway only when a restart request exists", () => {
    const root = tempDirs.make("telegram-mantis-supervisor-");
    const binDir = path.join(root, "bin");
    const countFile = path.join(root, "gateway-count");
    const configPath = path.join(root, "openclaw.json");
    const gatewayLog = path.join(root, "gateway.log");
    fs.mkdirSync(binDir);
    fs.writeFileSync(configPath, "{}\n");
    fs.writeFileSync(
      path.join(binDir, "node"),
      `#!/bin/sh
count=0
if [ -f ${JSON.stringify(countFile)} ]; then count=$(cat ${JSON.stringify(countFile)}); fi
count=$((count + 1))
printf '%s\\n' "$count" > ${JSON.stringify(countFile)}
printf '[gateway] ready\\n'
if [ "\${RESTART_ON_FIRST:-0}" = 1 ] && [ "$count" -eq 1 ]; then
  : > ${JSON.stringify(path.join(root, "gateway-restart.request"))}
  exit 23
fi
exit "\${GATEWAY_EXIT_CODE:-0}"
`,
      { mode: 0o755 },
    );
    const run = (extraEnv: NodeJS.ProcessEnv) =>
      spawnSync("/bin/sh", ["-c", sutSupervisorCommand()], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...extraEnv,
          GATEWAY_LOG: gatewayLog,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_PORT: "19879",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });

    const restarted = run({ RESTART_ON_FIRST: "1" });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(fs.readFileSync(countFile, "utf8").trim()).toBe("2");
    expect(fs.readFileSync(gatewayLog, "utf8")).toContain("[mantis] restarting gateway");
    expect(fs.existsSync(path.join(root, "gateway.pid"))).toBe(false);

    fs.rmSync(countFile);
    fs.rmSync(gatewayLog);
    const exited = run({ GATEWAY_EXIT_CODE: "23" });
    expect(exited.status, exited.stderr).toBe(23);
    expect(fs.readFileSync(countFile, "utf8").trim()).toBe("1");
    expect(fs.readFileSync(gatewayLog, "utf8")).not.toContain("restarting gateway");
    expect(fs.existsSync(path.join(root, "gateway.pid"))).toBe(false);
  });

  it("lets the proof agent patch the complete ephemeral gateway config", () => {
    const outputDir = tempDirs.make("telegram-mantis-config-");
    const { configPath } = writeSutConfig({
      configPatch: {
        channels: {
          telegram: {
            apiRoot: "https://example.invalid",
            botToken: "not-the-sut-token",
            streaming: { mode: "partial" },
          },
        },
        session: { sendPolicy: { default: "deny" } },
      },
      gatewayPort: 19_879,
      groupId: "-100123456789",
      mockHost: "mock-openai",
      mockPort: 19_882,
      outputDir,
      testerId: "12345",
    });

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.channels.telegram.apiRoot).toBe("https://example.invalid");
    expect(config.channels.telegram.botToken).toBe("not-the-sut-token");
    expect(config.channels.telegram.streaming).toEqual({ mode: "partial" });
    expect(config.channels.telegram).not.toHaveProperty("replyToMode");
    expect(config.commands.ownerAllowFrom).toEqual(["telegram:12345"]);
    expect(config.models.providers.openai.baseUrl).toBe("http://mock-openai:19882/v1");
    expect(config.session.sendPolicy).toEqual({ default: "deny" });
  });
});
