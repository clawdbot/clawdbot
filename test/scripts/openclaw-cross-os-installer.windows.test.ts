import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildInstallerSmokeScript,
  runCommand,
} from "../../scripts/lib/cross-os-release-checks/index.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function powerShellSingleQuote(value: string) {
  return value.replace(/'/gu, "''");
}

async function runPowerShell(params: {
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  return runCommand(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      params.script,
    ],
    {
      check: false,
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 10_000,
    },
  );
}

async function runPosixShell(params: {
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  return runCommand("/bin/bash", ["-lc", params.script], {
    check: false,
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 10_000,
  });
}

function installerTempFiles(dir: string) {
  return readdirSync(dir).filter((entry) => entry.startsWith("openclaw-installer-"));
}

describe("cross-OS installer fetch", () => {
  it.runIf(process.platform !== "win32")(
    "buffers POSIX installers before execution and cleans up timed-out downloads",
    async () => {
      const dir = tempDirs.make("openclaw-cross-os-installer-");
      const healthyMarker = join(dir, "healthy.txt");
      const stalledMarker = join(dir, "stalled.txt");
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        if (request.url === "/healthy") {
          response.end('printf "%s" "$1|$2|$3" > "$OPENCLAW_PROOF_HEALTHY_MARKER"\n');
          return;
        }
        response.write('printf executed > "$OPENCLAW_PROOF_STALL_MARKER"\n');
      });

      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          server.once("error", rejectPromise);
          server.listen(0, "127.0.0.1", resolvePromise);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("POSIX installer proof server did not bind to a TCP port.");
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const env = {
          ...process.env,
          TMPDIR: dir,
          OPENCLAW_PROOF_HEALTHY_MARKER: healthyMarker,
          OPENCLAW_PROOF_STALL_MARKER: stalledMarker,
        };
        const timeouts = { connectTimeoutSeconds: 2, requestTimeoutSeconds: 1 };

        const healthy = await runPosixShell({
          script: buildInstallerSmokeScript(
            {
              installerUrl: `${baseUrl}/healthy`,
              installTarget: "proof-target",
              platform: "linux",
            },
            timeouts,
          ),
          cwd: dir,
          env,
          logPath: join(dir, "healthy.log"),
        });

        expect(healthy.exitCode).toBe(0);
        expect(readFileSync(healthyMarker, "utf8")).toBe("--version|proof-target|--no-onboard");
        expect(installerTempFiles(dir)).toEqual([]);

        const stalled = await runPosixShell({
          script: buildInstallerSmokeScript(
            {
              installerUrl: `${baseUrl}/stalled`,
              installTarget: "proof-target",
              platform: "linux",
            },
            timeouts,
          ),
          cwd: dir,
          env,
          logPath: join(dir, "stalled.log"),
        });

        expect(stalled.exitCode).toBe(28);
        expect(existsSync(stalledMarker)).toBe(false);
        expect(installerTempFiles(dir)).toEqual([]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        });
      }
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "times out stalled bodies without executing partial scripts or leaking temp files",
    async () => {
      const dir = tempDirs.make("openclaw-cross-os-installer-");
      const healthyMarker = join(dir, "healthy.txt");
      const stalledMarker = join(dir, "stalled.txt");
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        if (request.url === "/healthy") {
          response.end(
            [
              "param([string] $Tag, [switch] $NoOnboard)",
              `[System.IO.File]::WriteAllText('${powerShellSingleQuote(healthyMarker)}', "tag=$Tag noOnboard=$($NoOnboard.IsPresent)")`,
            ].join("\n"),
          );
          return;
        }
        response.write(
          `[System.IO.File]::WriteAllText('${powerShellSingleQuote(stalledMarker)}', 'executed')\n`,
        );
      });

      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          server.once("error", rejectPromise);
          server.listen(0, "127.0.0.1", resolvePromise);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Windows installer proof server did not bind to a TCP port.");
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const env = { ...process.env, TEMP: dir, TMP: dir };
        const timeouts = { connectTimeoutSeconds: 2, requestTimeoutSeconds: 1 };

        const healthy = await runPowerShell({
          script: buildInstallerSmokeScript(
            {
              installerUrl: `${baseUrl}/healthy`,
              installTarget: "proof-target",
              platform: "win32",
            },
            timeouts,
          ),
          cwd: dir,
          env,
          logPath: join(dir, "healthy.log"),
        });

        expect(healthy.exitCode).toBe(0);
        expect(readFileSync(healthyMarker, "utf8")).toBe("tag=proof-target noOnboard=True");
        expect(installerTempFiles(dir)).toEqual([]);

        const stalled = await runPowerShell({
          script: buildInstallerSmokeScript(
            {
              installerUrl: `${baseUrl}/stalled`,
              installTarget: "proof-target",
              platform: "win32",
            },
            timeouts,
          ),
          cwd: dir,
          env,
          logPath: join(dir, "stalled.log"),
        });

        expect(stalled.exitCode).not.toBe(0);
        expect(`${stalled.stdout}\n${stalled.stderr}`).toContain("exit 28");
        expect(existsSync(stalledMarker)).toBe(false);
        expect(installerTempFiles(dir)).toEqual([]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        });
      }
    },
    15_000,
  );
});
