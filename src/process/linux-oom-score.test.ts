import { describe, expect, it } from "vitest";
import {
  hardenedEnvForChildOomWrap,
  prepareOomScoreAdjustedSpawn,
  wrapArgvForChildOomScoreRaise,
} from "./linux-oom-score.js";

const argv = ["/usr/bin/node", "--max-old-space-size=256", "run.js", "arg with spaces"];
const wrapScript = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';
const linux = { platform: "linux", env: {}, shellAvailable: () => true } as const;
const linuxNoShell = { platform: "linux", env: {}, shellAvailable: () => false } as const;

describe("wrapArgvForChildOomScoreRaise", () => {
  it("wraps argv on linux with default env", () => {
    const result = wrapArgvForChildOomScoreRaise(argv, linux);
    expect(result.slice(0, 3)).toEqual(["/bin/sh", "-c", wrapScript]);
    expect(result.slice(3)).toEqual(argv);
  });

  it("returns argv unchanged on non-linux platforms", () => {
    for (const platform of ["darwin", "win32", "freebsd"] as const) {
      expect(
        wrapArgvForChildOomScoreRaise(argv, { platform, env: {}, shellAvailable: () => true }),
      ).toEqual(argv);
    }
  });

  it("respects the OPENCLAW_CHILD_OOM_SCORE_ADJ opt-out", () => {
    for (const value of ["0", "false", "FALSE", "no", "off"]) {
      expect(
        wrapArgvForChildOomScoreRaise(argv, {
          ...linux,
          env: { OPENCLAW_CHILD_OOM_SCORE_ADJ: value },
        }),
      ).toEqual(argv);
    }
  });

  it("skips wrap when /bin/sh is unavailable (distroless/scratch)", () => {
    expect(wrapArgvForChildOomScoreRaise(argv, linuxNoShell)).toEqual(argv);
  });

  it("does not double-wrap already-wrapped argv", () => {
    const once = wrapArgvForChildOomScoreRaise(argv, linux);
    const twice = wrapArgvForChildOomScoreRaise(once, linux);
    expect(twice).toEqual(once);
  });

  it("returns empty argv unchanged", () => {
    expect(wrapArgvForChildOomScoreRaise([], linux)).toStrictEqual([]);
  });

  it("skips wrap for command names that exec could parse as options", () => {
    expect(wrapArgvForChildOomScoreRaise(["-p", "node"], linux)).toEqual(["-p", "node"]);
  });
});

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
});

describe("hardenedEnvForChildOomWrap", () => {
  const tainted = { PATH: "/usr/bin", BASH_ENV: "/tmp/evil.sh", ENV: "/tmp/evil", CDPATH: "/tmp" };

  it("strips shell-init keys when wrap applies", () => {
    expect(hardenedEnvForChildOomWrap(tainted, linux)).toEqual({ PATH: "/usr/bin" });
  });

  it("preserves baseEnv (including undefined) when wrap does not apply", () => {
    expect(hardenedEnvForChildOomWrap(tainted, linuxNoShell)).toBe(tainted);
    expect(
      hardenedEnvForChildOomWrap(undefined, { platform: "darwin", shellAvailable: () => true }),
    ).toBeUndefined();
    expect(
      hardenedEnvForChildOomWrap(tainted, { ...linux, env: { OPENCLAW_CHILD_OOM_SCORE_ADJ: "0" } }),
    ).toBe(tainted);
  });
});
