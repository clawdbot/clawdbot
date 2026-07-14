// OpenClaw prepack tests validate package prepack output.
import { describe, expect, it } from "vitest";
import {
  collectPreparedPrepackErrors,
  resolvePrepackAllowUnreleasedChangelog,
  resolvePrepackBuildEnvironment,
  resolvePrepackCommandStdio,
  resolvePrepackCommandTimeoutMs,
  runPrepackCommand,
} from "../scripts/openclaw-prepack.ts";

describe("resolvePrepackAllowUnreleasedChangelog", () => {
  it("requires an explicit non-publish opt-in", () => {
    for (const raw of [undefined, "", "0", "false"]) {
      expect(
        resolvePrepackAllowUnreleasedChangelog({
          OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: raw,
        }),
      ).toBe(false);
    }
    for (const raw of ["1", "true"]) {
      expect(
        resolvePrepackAllowUnreleasedChangelog({
          OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: raw,
        }),
      ).toBe(true);
    }
    expect(() =>
      resolvePrepackAllowUnreleasedChangelog({
        OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: "yes",
      }),
    ).toThrow("invalid OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: yes");
  });
});

describe("resolvePrepackBuildEnvironment", () => {
  it("pins one timestamp across package and Control UI builds", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(
      resolvePrepackBuildEnvironment(
        {},
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => commit,
      ),
    ).toMatchObject({
      GIT_COMMIT: commit,
      OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56.000Z",
    });
    expect(
      resolvePrepackBuildEnvironment(
        { OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03.7Z" },
        () => new Date("2026-07-11T00:00:00.000Z"),
        () => commit,
      ).OPENCLAW_BUILD_TIMESTAMP,
    ).toBe("2026-07-10T01:02:03.7Z");
  });

  it("normalizes explicit commit aliases and rejects malformed values", () => {
    expect(
      resolvePrepackBuildEnvironment(
        { GIT_SHA: "A".repeat(40) },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => "b".repeat(40),
      ).GIT_COMMIT,
    ).toBe("a".repeat(40));
    expect(() =>
      resolvePrepackBuildEnvironment({ GIT_COMMIT: "deadbeef" }, undefined, () => null),
    ).toThrow("full 40-character hexadecimal SHA");
  });

  it("uses checked-out Git instead of unverified GitHub workflow context", () => {
    const checkedOutCommit = "b".repeat(40);
    const ambientCommit = "a".repeat(40);

    expect(
      resolvePrepackBuildEnvironment(
        { GITHUB_SHA: ambientCommit },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => checkedOutCommit,
      ).GIT_COMMIT,
    ).toBe(checkedOutCommit);
    expect(
      resolvePrepackBuildEnvironment(
        { GITHUB_SHA: ambientCommit },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => null,
      ).GIT_COMMIT,
    ).toBe(ambientCommit);
    expect(() =>
      resolvePrepackBuildEnvironment(
        { GITHUB_SHA: "bad" },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => null,
      ),
    ).toThrow("full 40-character hexadecimal SHA");
  });
});

describe("collectPreparedPrepackErrors", () => {
  it("accepts prepared release artifacts", () => {
    expect(
      collectPreparedPrepackErrors(
        ["dist/index.mjs", "dist/control-ui/index.html"],
        [
          "dist/control-ui/assets/index-Bu8rSoJV.js",
          "dist/control-ui/assets/index-Bu8rSoJV.js.br",
          "dist/control-ui/assets/index-Bu8rSoJV.js.gz",
        ],
      ),
    ).toStrictEqual([]);
  });

  it("rejects a stale Control UI build without precompressed variants", () => {
    expect(
      collectPreparedPrepackErrors(
        ["dist/index.mjs", "dist/control-ui/index.html"],
        ["dist/control-ui/assets/index-Bu8rSoJV.js"],
      ),
    ).toEqual([
      "missing prepared Control UI .br asset under dist/control-ui/assets/",
      "missing prepared Control UI .gz asset under dist/control-ui/assets/",
    ]);
  });

  it("reports missing build and control ui artifacts", () => {
    expect(collectPreparedPrepackErrors([], [])).toEqual([
      "missing required prepared artifact: dist/index.js or dist/index.mjs",
      "missing required prepared artifact: dist/control-ui/index.html",
      "missing prepared Control UI asset payload under dist/control-ui/assets/",
    ]);
  });
});

describe("runPrepackCommand", () => {
  it("keeps prepack child stdout off npm pack JSON stdout", () => {
    expect(resolvePrepackCommandStdio({ stdio: "inherit" }, { npm_config_json: "true" })).toEqual([
      "inherit",
      2,
      "inherit",
    ]);
    expect(
      resolvePrepackCommandStdio(
        { stdio: ["ignore", "pipe", "pipe"] },
        { npm_config_json: "true" },
      ),
    ).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("returns captured output for successful commands", () => {
    const result = runPrepackCommand(process.execPath, ["--eval", "process.stdout.write('ok')"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("bounds commands that ignore termination", () => {
    const startedAt = Date.now();
    const result = runPrepackCommand(
      process.execPath,
      ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 100,
      },
    );

    expect(result.error).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });
});

describe("resolvePrepackCommandTimeoutMs", () => {
  it("parses only positive integer environment timeouts", () => {
    expect(resolvePrepackCommandTimeoutMs({})).toBe(30 * 60 * 1000);
    expect(resolvePrepackCommandTimeoutMs({ OPENCLAW_PREPACK_COMMAND_TIMEOUT_MS: "" })).toBe(
      30 * 60 * 1000,
    );
    expect(resolvePrepackCommandTimeoutMs({ OPENCLAW_PREPACK_COMMAND_TIMEOUT_MS: "1234" })).toBe(
      1234,
    );

    for (const raw of ["nope", "10m", "1e3", "0", "-1", "9007199254740992"]) {
      expect(() =>
        resolvePrepackCommandTimeoutMs({ OPENCLAW_PREPACK_COMMAND_TIMEOUT_MS: raw }),
      ).toThrow(`invalid OPENCLAW_PREPACK_COMMAND_TIMEOUT_MS: ${raw}`);
    }
  });
});
