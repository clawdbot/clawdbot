import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const resolverPath = path.resolve("scripts/secrets/openclaw-bws-resolver.mjs");

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-bws-resolver-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("openclaw-bws-resolver", () => {
  it("forwards the self-hosted server URL without inheriting unrelated variables", () => {
    const dir = makeTempDir();
    const fakeBwsPath = path.join(dir, "bws");
    writeFileSync(
      fakeBwsPath,
      [
        "#!/usr/bin/env node",
        'if (process.env.BWS_ACCESS_TOKEN !== "test-token") process.exit(10);',
        'if (process.env.BWS_SERVER_URL !== "https://bws.example.test") process.exit(11);',
        "if (process.env.UNRELATED_PARENT_VALUE !== undefined) process.exit(12);",
        'process.stdout.write(JSON.stringify([{ key: "example", value: "resolved" }]));',
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(fakeBwsPath, 0o755);

    const result = spawnSync(process.execPath, [resolverPath], {
      encoding: "utf8",
      env: {
        BWS_ACCESS_TOKEN: "test-token",
        BWS_BIN: fakeBwsPath,
        BWS_SERVER_URL: "https://bws.example.test",
        PATH: process.env.PATH ?? "",
        UNRELATED_PARENT_VALUE: "do-not-forward",
      },
      input: JSON.stringify({ protocolVersion: 1, ids: ["example"] }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: { example: "resolved" },
      errors: {},
    });
  });

  it("returns bounded error codes for missing and ambiguous keys", () => {
    const dir = makeTempDir();
    const fakeBwsPath = path.join(dir, "bws");
    writeFileSync(
      fakeBwsPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify([",
        '  { key: "duplicate", value: "first" },',
        '  { key: "duplicate", value: "second" },',
        "]));",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(fakeBwsPath, 0o755);

    const result = spawnSync(process.execPath, [resolverPath], {
      encoding: "utf8",
      env: {
        BWS_ACCESS_TOKEN: "test-token",
        BWS_BIN: fakeBwsPath,
        PATH: process.env.PATH ?? "",
      },
      input: JSON.stringify({ protocolVersion: 1, ids: ["missing", "duplicate"] }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        missing: { code: "NOT_FOUND" },
        duplicate: { code: "AMBIGUOUS_DUPLICATE_KEY" },
      },
    });
  });
});
