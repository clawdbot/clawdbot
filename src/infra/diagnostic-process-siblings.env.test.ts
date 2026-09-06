import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { forceFreePort, forceFreePortAndWait } from "../cli/ports.js";
import {
  createDiagnosticFixtureRouting,
  diagnosticCanaries,
  diagnosticEnvReportScript,
  withSyntheticDiagnosticEnv,
} from "./diagnostic-env.test-support.js";
import { readActiveGatewayLockIdentity } from "./gateway-lock.js";
import { cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import { spawnPsSync } from "./spawn-ps.js";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), probe: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.exec,
  spawnSync: mocks.spawn,
}));
vi.mock("./ports-lsof.js", () => ({ resolveLsofCommandSync: () => "lsof" }));
vi.mock("./ports-probe.js", () => ({ probePortUsage: mocks.probe }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each([
  "shared ps",
  "restart scan",
  "restart poll",
  "lock argv",
  "CLI lsof",
  "CLI netstat",
  "CLI fuser",
  "CLI fuser TERM",
  "CLI fuser KILL",
])("projects the environment at the %s launch boundary", async (surface) => {
  const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "diagnostic-siblings-")));
  const routing = createDiagnosticFixtureRouting({
    PATH: root,
    HOME: root,
    TMPDIR: root,
    LANG: "C",
    TZ: "UTC",
  });
  vi.spyOn(process, "platform", "get").mockReturnValue(
    surface === "CLI netstat" ? "win32" : surface.startsWith("CLI fuser") ? "linux" : "darwin",
  );
  const killMock = vi.spyOn(process, "kill").mockImplementation(() => {
    if (surface === "restart poll") {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
    return true;
  });
  try {
    await withSyntheticDiagnosticEnv(routing, async () => {
      const reports: Array<{ command: string; report: unknown }> = [];
      const capture = (command: string, env?: NodeJS.ProcessEnv) => {
        const stdout = native.execFileSync(
          process.execPath,
          ["-e", `process.stdout.write(${diagnosticEnvReportScript(routing)})`],
          { env, encoding: "utf8", timeout: 5000 },
        );
        reports.push({ command, report: JSON.parse(stdout) });
      };
      let lsofCalls = 0;
      const fuserArgs: string[][] = [];
      mocks.spawn.mockImplementation(
        (command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          capture(command, options.env);
          if (command === "ps") {
            return { status: 0, stdout: surface === "shared ps" ? "fixture-user" : "" };
          }
          lsofCalls += 1;
          return {
            status: lsofCalls > 1 ? 1 : 0,
            stdout: lsofCalls > 1 ? "" : "p424242\ncopenclaw-gateway\n",
          };
        },
      );
      mocks.exec.mockImplementation(
        (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          capture([command, ...args].join(" "), options.env);
          if (command === "lsof" && surface.startsWith("CLI fuser")) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          if (command === "ps") {
            return "node openclaw.mjs gateway";
          }
          if (command === "fuser") {
            fuserArgs.push(args);
            mocks.probe.mockResolvedValue(
              surface === "CLI fuser KILL" && args.includes("-TERM") ? "busy" : "free",
            );
            return "424242";
          }
          if (command.endsWith("netstat.exe")) {
            return "TCP 127.0.0.1:43123 0.0.0.0:0 LISTENING 424242";
          }
          return "p424242\ncnode\n";
        },
      );
      const parent = { ...process.env };
      if (surface === "shared ps") {
        expect(spawnPsSync(["-p", "424242", "-o", "user="], 1000).stdout).toBe("fixture-user");
      } else if (surface === "restart scan") {
        expect(findGatewayPidsOnPortSync(43123)).toEqual([424242]);
      } else if (surface === "restart poll") {
        expect(cleanStaleGatewayProcessesSync(43123)).toEqual([]);
        expect(lsofCalls).toBe(2);
      } else if (surface === "lock argv") {
        await writeFile(
          path.join(root, "gateway.state.lock"),
          JSON.stringify({
            pid: 424242,
            port: 43123,
            createdAt: "2026-09-03T00:00:00Z",
            configPath: path.join(root, "openclaw.json"),
          }),
        );
        expect(
          await readActiveGatewayLockIdentity({ lockDir: root, env: { OPENCLAW_STATE_DIR: root } }),
        ).toMatchObject({ pid: 424242, port: 43123 });
      } else if (surface.startsWith("CLI fuser")) {
        mocks.probe.mockResolvedValue("busy");
        const beforeSignal = vi.fn();
        expect(
          await forceFreePortAndWait(43123, {
            sigtermTimeoutMs: 0,
            ...(surface === "CLI fuser" ? { beforeSignal } : {}),
          }),
        ).toEqual({
          killed: [{ pid: 424242 }],
          waitedMs: 0,
          escalatedToSigkill: surface === "CLI fuser KILL",
        });
        if (surface === "CLI fuser") {
          expect(fuserArgs).toEqual([["43123/tcp"]]);
          expect(beforeSignal).toHaveBeenCalledExactlyOnceWith({
            port: 43123,
            pid: 424242,
            signal: "SIGTERM",
          });
          expect(killMock).toHaveBeenCalledExactlyOnceWith(424242, "SIGTERM");
        } else {
          expect(fuserArgs).toEqual(
            (surface === "CLI fuser KILL" ? ["TERM", "KILL"] : ["TERM"]).map((signal) => [
              "-k",
              `-${signal}`,
              "43123/tcp",
            ]),
          );
          expect(killMock).not.toHaveBeenCalled();
        }
      } else {
        expect(forceFreePort(43123)).toEqual([expect.objectContaining({ pid: 424242 })]);
      }
      expect(process.env).toEqual(parent);
      expect(reports.length).toBeGreaterThan(0);
      for (const { command, report } of reports) {
        expect.soft(report, `${command} inherited canary presence`).toEqual({
          present: Object.fromEntries(Object.keys(diagnosticCanaries).map((key) => [key, false])),
          routingPreserved: true,
        });
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
