import { describe, expect, it } from "vitest";
import {
  checkUnusedFiles,
  compareUnusedFilesToAllowlist,
  KNIP_MAX_BUFFER_BYTES,
  KNIP_TIMEOUT_MS,
  parseKnipCompactUnusedFiles,
  runKnipUnusedFiles,
} from "../../scripts/check-deadcode-unused-files.mjs";

describe("check-deadcode-unused-files", () => {
  it("parses the compact Knip unused-file section", () => {
    expect(
      parseKnipCompactUnusedFiles(`
> openclaw@2026.4.27 deadcode:knip /repo
> pnpm dlx knip --reporter compact --files

Unused files (2)
src/b.ts: src/b.ts
src/a.ts: src/a.ts

Unused dependencies (1)
left-pad: package.json
`),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("parses Knip's files-only compact output", () => {
    expect(parseKnipCompactUnusedFiles("src/b.ts: src/b.ts\nsrc/a.ts: src/a.ts\n")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("ignores pnpm dlx progress lines in files-only compact output", () => {
    expect(
      parseKnipCompactUnusedFiles(`
Progress: resolved 21, reused 0, downloaded 0, added 0
src/b.ts: src/b.ts
Progress: resolved 65, reused 20, downloaded 1, added 21, done
src/a.ts: src/a.ts
`),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports unexpected and stale allowlist entries", () => {
    expect(
      compareUnusedFilesToAllowlist(["src/a.ts", "src/new.ts"], ["src/a.ts", "src/old.ts"]),
    ).toStrictEqual({
      actual: ["src/a.ts", "src/new.ts"],
      allowed: ["src/a.ts", "src/old.ts"],
      unexpected: ["src/new.ts"],
      stale: ["src/old.ts"],
      duplicateAllowedCount: 0,
      allowlistIsSorted: true,
    });
  });

  it("accepts optional allowlist entries whether Knip reports them or not", () => {
    expect(
      compareUnusedFilesToAllowlist(
        ["src/a.ts", "src/platform.ts"],
        ["src/a.ts"],
        ["src/platform.ts"],
      ),
    ).toStrictEqual({
      actual: ["src/a.ts", "src/platform.ts"],
      allowed: ["src/a.ts"],
      allowlistIsSorted: true,
      duplicateAllowedCount: 0,
      unexpected: [],
      stale: [],
    });
    expect(
      compareUnusedFilesToAllowlist(["src/a.ts"], ["src/a.ts"], ["src/platform.ts"]),
    ).toStrictEqual({
      actual: ["src/a.ts"],
      allowed: ["src/a.ts"],
      allowlistIsSorted: true,
      duplicateAllowedCount: 0,
      unexpected: [],
      stale: [],
    });
  });

  it("accepts exactly allowlisted unused files", () => {
    expect(checkUnusedFiles("Unused files (1)\nsrc/a.ts: src/a.ts\n", ["src/a.ts"])).toStrictEqual({
      comparison: {
        actual: ["src/a.ts"],
        allowed: ["src/a.ts"],
        allowlistIsSorted: true,
        duplicateAllowedCount: 0,
        stale: [],
        unexpected: [],
      },
      ok: true,
      message: "",
    });
  });

  it("rejects unsorted allowlists", () => {
    expect(
      compareUnusedFilesToAllowlist(["src/a.ts", "src/b.ts"], ["src/b.ts", "src/a.ts"]),
    ).toStrictEqual({
      actual: ["src/a.ts", "src/b.ts"],
      allowed: ["src/a.ts", "src/b.ts"],
      allowlistIsSorted: false,
      duplicateAllowedCount: 0,
      stale: [],
      unexpected: [],
    });
  });

  it("bounds Knip execution and reports spawn errors", () => {
    const calls: unknown[] = [];
    const timeoutError = Object.assign(new Error("spawnSync pnpm ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    const result = runKnipUnusedFiles({
      spawnSyncCommand(command: string, args: string[], options: unknown) {
        calls.push({ args, command, options });
        return {
          error: timeoutError,
          signal: "SIGTERM",
          status: null,
          stderr: "partial stderr",
          stdout: "partial stdout",
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: [
        "--config.minimum-release-age=0",
        "dlx",
        "knip@6.8.0",
        "--config",
        "config/knip.config.ts",
        "--production",
        "--no-progress",
        "--reporter",
        "compact",
        "--files",
        "--no-config-hints",
      ],
      command: "pnpm",
      options: {
        killSignal: "SIGTERM",
        maxBuffer: KNIP_MAX_BUFFER_BYTES,
        timeout: KNIP_TIMEOUT_MS,
      },
    });
    expect(result).toStrictEqual({
      errorCode: "ETIMEDOUT",
      errorMessage: "spawnSync pnpm ETIMEDOUT",
      output: "partial stdoutpartial stderr",
      signal: "SIGTERM",
      status: null,
    });
  });
});
