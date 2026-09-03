// Linux OOM score tests cover best-effort process OOM score adjustment.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareOomScoreAdjustedSpawn,
  prepareOomScoreAdjustedSpawnPreservingExecEnv,
  type OomScoreAdjustedSpawn,
} from "./linux-oom-score.js";

const wrapScript = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';
const carriers = {
  BASH_ENV: "OC_INTERNAL_OOM_EXEC_BASH_ENV",
  ENV: "OC_INTERNAL_OOM_EXEC_ENV",
  CDPATH: "OC_INTERNAL_OOM_EXEC_CDPATH",
  PS4: "OC_INTERNAL_OOM_EXEC_PS4",
} as const;
const restoreScript = [
  "echo 1000 > /proc/self/oom_score_adj 2>/dev/null",
  `if [ "\${${carriers.BASH_ENV}+x}" = x ]; then BASH_ENV="$${carriers.BASH_ENV}"; export BASH_ENV; fi; unset ${carriers.BASH_ENV}`,
  `if [ "\${${carriers.ENV}+x}" = x ]; then ENV="$${carriers.ENV}"; export ENV; fi; unset ${carriers.ENV}`,
  `if [ "\${${carriers.CDPATH}+x}" = x ]; then CDPATH="$${carriers.CDPATH}"; export CDPATH; fi; unset ${carriers.CDPATH}`,
  `if [ "\${${carriers.PS4}+x}" = x ]; then PS4="$${carriers.PS4}"; export PS4; fi; unset ${carriers.PS4}`,
  'exec "$0" "$@"',
].join("; ");
const linux = { platform: "linux", env: {}, shellAvailable: () => true } as const;
const bashAvailable = fs.existsSync("/bin/bash");

function spawnPreparedWithBashAsSh(prepared: OomScoreAdjustedSpawn) {
  return spawnSync(prepared.wrapped ? "/bin/bash" : prepared.command, prepared.args, {
    ...(prepared.wrapped
      ? { argv0: "sh" }
      : prepared.argv0 === undefined
        ? {}
        : { argv0: prepared.argv0 }),
    env: prepared.env,
    encoding: "utf8",
  });
}

describe("prepareOomScoreAdjustedSpawn", () => {
  it("returns command, args, and hardened env when wrap applies", () => {
    const result = prepareOomScoreAdjustedSpawn("/usr/bin/node", ["run.js"], {
      ...linux,
      env: {
        PATH: "/usr/bin",
        BASH_ENV: "/tmp/bashenv",
        ENV: "/tmp/env",
        CDPATH: "/tmp",
        SHELLOPTS: "xtrace",
        BASHOPTS: "extdebug",
        PS4: "trace",
        "BASH_FUNC_echo%%": "() { :; }",
      },
    });
    expect(result).toEqual({
      command: "/bin/sh",
      args: ["-c", wrapScript, "/usr/bin/node", "run.js"],
      env: { PATH: "/usr/bin" },
      wrapped: true,
    });
  });

  it("preserves the spawn shape when wrap does not apply", () => {
    const env = { PATH: "/usr/bin" };
    expect(
      prepareOomScoreAdjustedSpawn("/usr/bin/node", ["run.js"], {
        platform: "darwin",
        env,
        shellAvailable: () => true,
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["run.js"],
      env,
      wrapped: false,
    });
  });

  it("keeps a distinct child argv0 out of the shell wrapper", () => {
    const argv0 = "/opt/shims/claude";
    const options = { ...linux, argv0 };

    expect(prepareOomScoreAdjustedSpawn("/usr/bin/mise", ["-p"], options)).toEqual({
      command: "/usr/bin/mise",
      args: ["-p"],
      argv0,
      env: {},
      wrapped: false,
    });
  });

  it.each(["0", "false", "FALSE", "no", "off"])(
    "respects the OPENCLAW_CHILD_OOM_SCORE_ADJ=%s opt-out",
    (value) => {
      expect(
        prepareOomScoreAdjustedSpawn("/usr/bin/node", ["run.js"], {
          ...linux,
          env: { OPENCLAW_CHILD_OOM_SCORE_ADJ: value },
        }),
      ).toMatchObject({ command: "/usr/bin/node", args: ["run.js"], wrapped: false });
    },
  );

  it("skips wrapping when the shell is unavailable", () => {
    expect(
      prepareOomScoreAdjustedSpawn("/usr/bin/node", ["run.js"], {
        ...linux,
        shellAvailable: () => false,
      }),
    ).toMatchObject({ command: "/usr/bin/node", args: ["run.js"], wrapped: false });
  });

  it("does not double-wrap an adjusted command", () => {
    expect(
      prepareOomScoreAdjustedSpawn("/bin/sh", ["-c", wrapScript, "/usr/bin/node", "run.js"], {
        ...linux,
        env: {
          PATH: "/usr/bin",
          BASH_ENV: "/tmp/bashenv",
          SHELLOPTS: "xtrace",
          BASHOPTS: "extdebug",
          PS4: "trace",
          "BASH_FUNC_echo%%": "() { :; }",
        },
      }),
    ).toEqual({
      command: "/bin/sh",
      args: ["-c", wrapScript, "/usr/bin/node", "run.js"],
      env: { PATH: "/usr/bin" },
      wrapped: true,
    });
  });

  it("does not pass command names that look like shell options to exec", () => {
    expect(prepareOomScoreAdjustedSpawn("-p", ["node"], linux)).toMatchObject({
      command: "-p",
      args: ["node"],
      wrapped: false,
    });
  });
});

describe("prepareOomScoreAdjustedSpawnPreservingExecEnv", () => {
  it("carries configured shell-init values without exposing them to the wrapper", () => {
    const result = prepareOomScoreAdjustedSpawnPreservingExecEnv("/usr/bin/node", ["run.js"], {
      ...linux,
      env: {
        PATH: "/usr/bin",
        BASH_ENV: "/tmp/bashenv",
        ENV: "",
        CDPATH: "line1\nline2",
        PS4: "final-trace-prefix",
      },
    });

    expect(result).toEqual({
      command: "/bin/sh",
      args: ["-c", restoreScript, "/usr/bin/node", "run.js"],
      env: {
        PATH: "/usr/bin",
        [carriers.BASH_ENV]: "/tmp/bashenv",
        [carriers.ENV]: "",
        [carriers.CDPATH]: "line1\nline2",
        [carriers.PS4]: "final-trace-prefix",
      },
      wrapped: true,
    });
  });

  it("does not create carriers for absent or undefined values", () => {
    expect(
      prepareOomScoreAdjustedSpawnPreservingExecEnv("/usr/bin/node", [], {
        ...linux,
        env: { PATH: "/usr/bin", BASH_ENV: undefined },
      }),
    ).toMatchObject({
      env: { PATH: "/usr/bin" },
      wrapped: true,
    });
  });

  it.each([
    ["SHELLOPTS", { SHELLOPTS: "xtrace" }],
    ["BASHOPTS", { BASHOPTS: "extdebug" }],
    ["imported function", { "BASH_FUNC_echo%%": "() { :; }" }],
  ])("falls back to direct spawn for defined %s controls", (_name, startupEnv) => {
    const env = { PATH: "/usr/bin", ...startupEnv };
    const result = prepareOomScoreAdjustedSpawnPreservingExecEnv("/usr/bin/node", ["run.js"], {
      ...linux,
      env,
    });

    expect(result).toEqual({
      command: "/usr/bin/node",
      args: ["run.js"],
      env,
      wrapped: false,
    });
    expect(result.env).toBe(env);
  });

  it("falls back to direct spawn on a defined carrier collision", () => {
    const env = {
      PATH: "/usr/bin",
      BASH_ENV: "/tmp/bashenv",
      [carriers.ENV]: "reserved",
    };
    const result = prepareOomScoreAdjustedSpawnPreservingExecEnv("/usr/bin/node", ["run.js"], {
      ...linux,
      env,
    });

    expect(result).toEqual({
      command: "/usr/bin/node",
      args: ["run.js"],
      env,
      wrapped: false,
    });
    expect(result.env).toBe(env);
  });

  it("ignores undefined carrier properties", () => {
    const result = prepareOomScoreAdjustedSpawnPreservingExecEnv("/usr/bin/node", [], {
      ...linux,
      env: {
        PATH: "/usr/bin",
        ENV: "",
        [carriers.ENV]: undefined,
        SHELLOPTS: undefined,
        BASHOPTS: undefined,
        "BASH_FUNC_echo%%": undefined,
      },
    });

    expect(result).toMatchObject({
      env: {
        PATH: "/usr/bin",
        [carriers.ENV]: "",
      },
      wrapped: true,
    });
  });

  it.each([
    {
      name: "non-Linux platform",
      command: "/usr/bin/node",
      options: { ...linux, platform: "darwin" as const },
    },
    {
      name: "OOM opt-out",
      command: "/usr/bin/node",
      options: { ...linux, env: { OPENCLAW_CHILD_OOM_SCORE_ADJ: "0", ENV: "" } },
    },
    {
      name: "missing shell",
      command: "/usr/bin/node",
      options: { ...linux, shellAvailable: () => false },
    },
    {
      name: "leading-dash command",
      command: "-p",
      options: linux,
    },
    {
      name: "custom argv0",
      command: "/usr/bin/node",
      options: { ...linux, argv0: "/opt/shims/node" },
    },
  ])("preserves the original environment for $name", ({ command, options }) => {
    const result = prepareOomScoreAdjustedSpawnPreservingExecEnv(command, ["run.js"], options);

    expect(result).toMatchObject({
      command,
      args: ["run.js"],
      env: options.env,
      wrapped: false,
    });
  });

  it.runIf(process.platform !== "win32")(
    "restores exact values only for the final executable",
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oom-env-"));
      const bashEnvPath = path.join(tempDir, "bash-env.sh");
      const startupMarkerPath = path.join(tempDir, "wrapper-startup-marker");
      fs.writeFileSync(bashEnvPath, `printf touched > "${startupMarkerPath}"\n`);
      try {
        const prepared = prepareOomScoreAdjustedSpawnPreservingExecEnv(
          process.execPath,
          [
            "-e",
            `process.stdout.write(JSON.stringify({bashEnv:process.env.BASH_ENV,envPresent:Object.hasOwn(process.env,"ENV"),env:process.env.ENV,cdpath:process.env.CDPATH,ps4:process.env.PS4,carrierKeys:Object.keys(process.env).filter(key=>key.startsWith("OC_INTERNAL_OOM_EXEC_"))}))`,
          ],
          {
            ...linux,
            env: {
              PATH: process.env.PATH,
              BASH_ENV: bashEnvPath,
              ENV: "",
              CDPATH: "line1\nline2",
              PS4: "final-trace-prefix",
            },
          },
        );
        const child = spawnSync(prepared.command, prepared.args, {
          env: prepared.env,
          encoding: "utf8",
        });

        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({
          bashEnv: bashEnvPath,
          envPresent: true,
          env: "",
          cdpath: "line1\nline2",
          ps4: "final-trace-prefix",
          carrierKeys: [],
        });
        expect(fs.existsSync(startupMarkerPath)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(bashAvailable)(
    "does not expose preserving carriers to Bash-as-sh xtrace startup",
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oom-xtrace-"));
      const markerPath = path.join(tempDir, "ps4-marker");
      const secret = "review-secret-carried-value";
      try {
        const env = {
          PATH: process.env.PATH,
          BASH_ENV: secret,
          SHELLOPTS: "braceexpand:hashall:interactive-comments:xtrace",
          PS4: `$(printf touched > "${markerPath}")trace `,
        };
        const prepared = prepareOomScoreAdjustedSpawnPreservingExecEnv(
          process.execPath,
          ["-e", ""],
          { ...linux, env },
        );
        const child = spawnPreparedWithBashAsSh(prepared);

        expect(child.status).toBe(0);
        expect(fs.existsSync(markerPath)).toBe(false);
        expect(child.stderr).not.toContain(secret);
        expect(child.stderr).not.toContain(carriers.BASH_ENV);
        expect(prepared.wrapped).toBe(false);
        expect(prepared.env).toBe(env);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(bashAvailable)("strips xtrace startup controls from Bash-as-sh", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oom-strip-xtrace-"));
    const markerPath = path.join(tempDir, "ps4-marker");
    try {
      const prepared = prepareOomScoreAdjustedSpawn(process.execPath, ["-e", ""], {
        ...linux,
        env: {
          PATH: process.env.PATH,
          SHELLOPTS: "braceexpand:hashall:interactive-comments:xtrace",
          PS4: `$(printf touched > "${markerPath}")trace `,
        },
      });
      const child = spawnPreparedWithBashAsSh(prepared);

      expect(child.status).toBe(0);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(prepared.wrapped).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux" && bashAvailable)(
    "blocks imported Bash functions from overriding wrapper commands",
    () => {
      for (const [prepare, expectedWrapped] of [
        [prepareOomScoreAdjustedSpawnPreservingExecEnv, false],
        [prepareOomScoreAdjustedSpawn, true],
      ] as const) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oom-function-"));
        const markerPath = path.join(tempDir, "echo-marker");
        try {
          const prepared = prepare(process.execPath, ["-e", ""], {
            ...linux,
            env: {
              PATH: process.env.PATH,
              "BASH_FUNC_echo%%": `() { printf touched > "${markerPath}"; builtin echo "$@"; }`,
            },
          });
          const child = spawnPreparedWithBashAsSh(prepared);

          expect(child.status).toBe(0);
          expect(fs.existsSync(markerPath)).toBe(false);
          expect(prepared.wrapped).toBe(expectedWrapped);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    },
  );
});
