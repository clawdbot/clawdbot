import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllowFromStoreReadCacheForTest,
  readChannelAllowFromStoreEntriesSync,
  resolveChannelAllowFromPath,
} from "./allow-from-store-read.js";

const tempDirs: string[] = [];

function makeEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
  };
}

function makeHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-allow-from-read-"));
  tempDirs.push(dir);
  return dir;
}

function writeAllowFromFile(params: {
  channel: "telegram";
  env: NodeJS.ProcessEnv;
  accountId?: string;
  allowFrom: string[];
}): void {
  const filePath = resolveChannelAllowFromPath(params.channel, params.env, params.accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 1, allowFrom: params.allowFrom }, null, 2),
    "utf8",
  );
}

afterEach(() => {
  clearAllowFromStoreReadCacheForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("allow-from-store-read", () => {
  it("merges scoped and legacy entries for the default account", () => {
    const env = makeEnv(makeHomeDir());
    writeAllowFromFile({
      channel: "telegram",
      env,
      allowFrom: [" legacy-a ", "legacy-a", "legacy-b"],
    });
    writeAllowFromFile({
      channel: "telegram",
      env,
      accountId: "default",
      allowFrom: [" scoped-a ", "legacy-b"],
    });

    expect(readChannelAllowFromStoreEntriesSync("telegram", env)).toEqual([
      "scoped-a",
      "legacy-b",
      "legacy-a",
    ]);
  });

  it("keeps non-default account reads scoped", () => {
    const env = makeEnv(makeHomeDir());
    writeAllowFromFile({
      channel: "telegram",
      env,
      allowFrom: ["legacy-a"],
    });
    writeAllowFromFile({
      channel: "telegram",
      env,
      accountId: "work",
      allowFrom: [" work-a ", "work-b"],
    });

    expect(readChannelAllowFromStoreEntriesSync("telegram", env, "work")).toEqual([
      "work-a",
      "work-b",
    ]);
  });
});
