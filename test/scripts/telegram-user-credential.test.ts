import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expandHome,
  resolvePrivateJsonDirectory,
  writePrivateJson,
} from "../../scripts/e2e/telegram-user-credential-paths.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("telegram user credential path handling", () => {
  it("expands home paths with the host path implementation", () => {
    expect(
      expandHome("~/payload.json", {
        env: { HOME: "/home/runner" },
        pathImpl: path.posix,
      }),
    ).toBe("/home/runner/payload.json");
    expect(
      expandHome("~/payload.json", {
        env: { USERPROFILE: String.raw`C:\Users\runner` },
        pathImpl: win32,
      }),
    ).toBe(String.raw`C:\Users\runner\payload.json`);
  });

  it("resolves native Windows private JSON parent directories", () => {
    expect(
      resolvePrivateJsonDirectory(String.raw`C:\Users\runner\AppData\Local\payload.json`, {
        pathImpl: win32,
      }),
    ).toBe(String.raw`C:\Users\runner\AppData\Local`);
  });

  it("resolves relative private JSON output to the current directory", () => {
    expect(resolvePrivateJsonDirectory("payload.json")).toBe(".");
  });

  it("writes private JSON files", async () => {
    const dir = makeTempDir("openclaw-telegram-credential-");
    await writePrivateJson(path.join(dir, "payload.json"), { status: "ok" });
    await expect(readFile(path.join(dir, "payload.json"), "utf8")).resolves.toBe(
      '{\n  "status": "ok"\n}\n',
    );
  });
});
