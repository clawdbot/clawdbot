import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "./service.test-helpers.js";

const execFileAsync = promisify(execFile);

async function runDriver(driver: string, env: NodeJS.ProcessEnv) {
  return await execFileAsync(
    process.execPath,
    [
      "--import",
      new URL("../../scripts/tsx.mjs", import.meta.url).href,
      "--input-type=module",
      "-e",
      driver,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

describe.skipIf(process.platform === "win32")("native control environment boundary", () => {
  it.each([false, true])(
    "keeps systemctl and busctl routing with machine fallback %s",
    async (fallback) => {
      await withTempDir("openclaw-manager-route-", async (temp) => {
        const home = await fs.realpath(temp);
        const bus = fallback ? undefined : `unix:path=${home}/bus`;
        const source = {
          HOME: home,
          PATH: home,
          USER: "target",
          LOGNAME: "target",
          XDG_RUNTIME_DIR: fallback ? path.join(home, "missing-runtime") : home,
          DBUS_SESSION_BUS_ADDRESS: bus,
          BOUNDARY_PARENT_ONLY: "synthetic-parent",
        };
        const callsPath = path.join(home, "calls.jsonl");
        for (const command of ["systemctl", "busctl"]) {
          await fs.writeFile(
            path.join(home, command),
            `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  command: ${JSON.stringify(command)}, args,
  canary: Object.hasOwn(process.env, "BOUNDARY_PARENT_ONLY"),
  native: process.env.PATH === ${JSON.stringify(home)} && process.env.USER === "target" && process.env.DBUS_SESSION_BUS_ADDRESS === ${JSON.stringify(bus)},
}) + "\\n");
if (${JSON.stringify(fallback ? "No medium found" : "")} && !args.includes("--machine")) {
  console.error("Failed to connect to bus: " + ${JSON.stringify(fallback ? "No medium found" : "")}); process.exit(1);
}
console.log("running");
`,
            { mode: 0o700 },
          );
        }
        const driver = `
import assert from "node:assert/strict";
import { execSystemctlUser, execBusctlUser } from ${JSON.stringify(new URL("./systemd-exec.ts", import.meta.url).href)};
process.geteuid = () => 1000;
const source = { ...process.env, XDG_RUNTIME_DIR: ${JSON.stringify(source.XDG_RUNTIME_DIR)}, DBUS_SESSION_BUS_ADDRESS: ${JSON.stringify(source.DBUS_SESSION_BUS_ADDRESS)} };
for (const execute of [execSystemctlUser, execBusctlUser]) {
  const result = await execute(source, ["status"], 5000);
  assert.equal(result.code, 0);
  assert.equal(result.termination, "exit");
}
`;
        await runDriver(driver, source);
        const calls = (await fs.readFile(callsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const expectedArgs = [
          ["--user", "status"],
          ...(fallback ? [["--machine", "target@", "--user", "status"]] : []),
        ];
        expect(calls).toEqual(
          ["systemctl", "busctl"].flatMap((command) =>
            expectedArgs.map((args) => ({
              command,
              args,
              canary: false,
              native: true,
            })),
          ),
        );
      });
    },
  );

  it("keeps loginctl account and sudo routing while closing both child environments", async () => {
    await withTempDir("openclaw-linger-env-", async (temp) => {
      const home = await fs.realpath(temp);
      const callsPath = path.join(home, "calls.jsonl");
      for (const command of ["loginctl", "sudo"]) {
        await fs.writeFile(
          path.join(home, command),
          `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  command: ${JSON.stringify(command)}, args: process.argv.slice(2),
  canary: Object.hasOwn(process.env, "BOUNDARY_PARENT_ONLY"),
}) + "\\n");
console.log("Linger=yes");
`,
          { mode: 0o700 },
        );
      }
      const driver = `
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readSystemdUserLingerStatus, enableSystemdUserLinger } from ${JSON.stringify(new URL("./systemd-linger.ts", import.meta.url).href)};
const realGetuid = process.getuid;
assert.deepEqual(await readSystemdUserLingerStatus({ env: { USER: "selected" } }), { user: "selected", linger: "yes" });
// Only the synchronous sudo decision is synthetic; logging must see the real filesystem owner.
mock.method(process, "getuid", () => 1000, { times: 1 });
assert.equal((await enableSystemdUserLinger({ env: { USER: "selected" }, sudoMode: "non-interactive" })).ok, true);
assert.equal(process.getuid, realGetuid);
mock.method(process, "getuid", () => 0, { times: 1 });
assert.equal((await enableSystemdUserLinger({ env: {}, user: "explicit" })).ok, true);
assert.equal(process.getuid, realGetuid);
`;
      await runDriver(driver, { HOME: home, PATH: home, BOUNDARY_PARENT_ONLY: "synthetic-parent" });
      const calls = (await fs.readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toEqual([
        { command: "loginctl", args: ["show-user", "selected", "-p", "Linger"], canary: false },
        { command: "sudo", args: ["-n", "loginctl", "enable-linger", "selected"], canary: false },
        { command: "loginctl", args: ["enable-linger", "explicit"], canary: false },
      ]);
    });
  });

  it("preserves effective service facts without leaking them to native children", async () => {
    await withTempDir("openclaw-service-env-", async (temp) => {
      const home = await fs.realpath(temp);
      const unit = "openclaw-boundary.service";
      const unitPath = path.join(home, ".config/systemd/user", unit);
      const envFile = path.join(home, "service.env");
      const callsPath = path.join(home, "calls.jsonl");
      const env = {
        HOME: home,
        PATH: home,
        USER: "boundary-user",
        LOGNAME: "boundary-user",
        XDG_RUNTIME_DIR: home,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/bus`,
        DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${home}/system-bus`,
        SYSTEMD_BUS_TIMEOUT: "2s",
        PSMODULEANALYSISCACHEPATH: path.join(home, "synthetic-module-cache"),
        OPENCLAW_SYSTEMD_UNIT: unit,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        BOUNDARY_PARENT_ONLY: "synthetic-parent",
      };
      const inline = [
        "BOUNDARY_INLINE=synthetic-inline",
        "BOUNDARY_SHARED=inline-before-file",
        "OPENCLAW_SYSTEMD_UNIT=stale-definition.service",
        "OPENCLAW_PROFILE=default",
      ];
      const definition = [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        ...inline.map((entry) => `Environment=${entry}`),
        `EnvironmentFile=${envFile}`,
        "",
      ].join("\n");
      const fileContents = "BOUNDARY_FILE=synthetic-file\nBOUNDARY_SHARED=file-wins\n";
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.mkdir(env.OPENCLAW_STATE_DIR);
      await fs.writeFile(unitPath, definition);
      await fs.writeFile(envFile, fileContents);
      const serviceProperties = buildSystemdManagerPropertyOutput({
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        environment: inline,
        environmentFiles: [[envFile, false]],
      });
      const unitProperties = buildSystemdUnitPropertyOutput({ fragmentPath: unitPath });
      const record = `
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  command: path.basename(process.argv[1]), args,
  canaries: ["BOUNDARY_PARENT_ONLY", "BOUNDARY_INLINE", "BOUNDARY_FILE", "BOUNDARY_SHARED"].map(name => Object.hasOwn(process.env, name)),
  selectors: ["OPENCLAW_SYSTEMD_UNIT", "OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR"].some(name => Object.hasOwn(process.env, name)),
  native: ${JSON.stringify(Object.entries(env).filter(([name]) => !name.startsWith("OPENCLAW_") && !name.startsWith("BOUNDARY_")))}.every(([name, value]) => process.env[name] === value),
  marker: process.env.OPENCLAW_CLI === "1",
}) + "\\n");`;
      for (const command of ["systemctl", "busctl"]) {
        await fs.writeFile(
          path.join(home, command),
          `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
${record}
if (${JSON.stringify(command)} === "busctl") {
  if (args.includes("LoadUnit")) console.log(JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/boundary"] }));
  else if (args.includes("org.freedesktop.systemd1.Unit")) console.log(${JSON.stringify(unitProperties)});
  else if (args.includes("org.freedesktop.systemd1.Service")) console.log(${JSON.stringify(serviceProperties)});
  else process.exit(91);
} else if (args.includes("status")) console.log("running");
else process.exit(92);
`,
          { mode: 0o700 },
        );
      }
      const driver = `
import assert from "node:assert/strict";
import { readSystemdServiceExecStart } from ${JSON.stringify(new URL("./systemd-service-files.ts", import.meta.url).href)};
import { mergeGatewayServiceEnv } from ${JSON.stringify(new URL("./service-env-merge.ts", import.meta.url).href)};
import { execSystemctlUser } from ${JSON.stringify(new URL("./systemd-exec.ts", import.meta.url).href)};
const command = await readSystemdServiceExecStart(process.env, { requireEffective: true });
assert.deepEqual(command.environment, {
  BOUNDARY_INLINE: "synthetic-inline", BOUNDARY_SHARED: "file-wins", BOUNDARY_FILE: "synthetic-file",
  OPENCLAW_SYSTEMD_UNIT: "stale-definition.service", OPENCLAW_PROFILE: "default",
});
assert.deepEqual(command.environmentValueSources, {
  BOUNDARY_INLINE: "inline", BOUNDARY_SHARED: "inline-and-file", BOUNDARY_FILE: "file",
  OPENCLAW_SYSTEMD_UNIT: "inline", OPENCLAW_PROFILE: "inline",
});
assert.deepEqual(command.definitionPaths, [${JSON.stringify(unitPath)}]);
const effectiveEnv = mergeGatewayServiceEnv(process.env, command);
assert.equal(effectiveEnv.OPENCLAW_SYSTEMD_UNIT, ${JSON.stringify(unit)});
assert.equal(effectiveEnv.BOUNDARY_PARENT_ONLY, "synthetic-parent");
assert.equal(effectiveEnv.BOUNDARY_FILE, "synthetic-file");
const result = await execSystemctlUser(effectiveEnv, ["status"], 5000);
assert.equal(result.code, 0);
`;
      await runDriver(driver, env);
      expect(await fs.readFile(unitPath, "utf8")).toBe(definition);
      expect(await fs.readFile(envFile, "utf8")).toBe(fileContents);
      const calls = (await fs.readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              command: string;
              args: string[];
              canaries: boolean[];
              selectors: boolean;
              native: boolean;
              marker: boolean;
            },
        );
      expect(new Set(calls.map((call) => call.command))).toEqual(new Set(["busctl", "systemctl"]));
      for (const call of calls) {
        expect(call, `${call.command} ${call.args.join(" ")}`).toMatchObject({
          canaries: [false, false, false, false],
          selectors: false,
          native: true,
          marker: true,
        });
      }
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("service manager routing environment", () => {
  it.each(["linux", "darwin", "win32"] as const)(
    "preserves %s native routing without arbitrary namespaces",
    (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const source = Object.freeze({
        PATH: "/native/bin",
        HOME: "/native/home",
        NO_COLOR: "",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus",
        XDG_RUNTIME_DIR: "/run/native",
        SYSTEMD_UNIT_PATH: "/units",
        SYSTEMD_BUS_TIMEOUT: "3s",
        SUDO_USER: "caller",
        SYSTEMD_PAGER: "untrusted",
        DBUS_APPLICATION: "synthetic",
        XDG_APPLICATION: "synthetic",
        NODE_OPTIONS: "--inspect",
        OPENCLAW_PROFILE: "private",
        BOUNDARY_PARENT_ONLY: "synthetic",
      });
      expect(resolveServiceManagerEnv(source)).toEqual({
        PATH: "/native/bin",
        HOME: "/native/home",
        NO_COLOR: "",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus",
        XDG_RUNTIME_DIR: "/run/native",
        SYSTEMD_UNIT_PATH: "/units",
        SYSTEMD_BUS_TIMEOUT: "3s",
        SUDO_USER: "caller",
      });
    },
  );

  it("uses the parent only when the source is omitted", () => {
    vi.stubEnv("HOME", "/parent/home");
    expect(resolveServiceManagerEnv().HOME).toBe("/parent/home");
    expect(resolveServiceManagerEnv({ HOME: undefined, PATH: "" })).toEqual({ PATH: "" });
    expect(resolveServiceManagerEnv({})).toEqual({});
  });
});
