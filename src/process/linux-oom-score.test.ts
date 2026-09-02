// Linux OOM score tests cover best-effort process OOM score adjustment.
import { describe, expect, it } from "vitest";
import { prepareOomScoreAdjustedSpawn } from "./linux-oom-score.js";

const wrapScript = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';
const linux = { platform: "linux", env: {}, shellAvailable: () => true } as const;

describe("prepareOomScoreAdjustedSpawn", () => {
  it("returns command, args, and hardened env when wrap applies", () => {
    const result = prepareOomScoreAdjustedSpawn("/usr/bin/node", ["run.js"], {
      ...linux,
      env: { PATH: "/usr/bin", BASH_ENV: "/tmp/bashenv", ENV: "/tmp/env", CDPATH: "/tmp" },
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
        env: { PATH: "/usr/bin", BASH_ENV: "/tmp/bashenv" },
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
