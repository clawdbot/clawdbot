// Qqbot tests cover store plugin behavior.
import fs from "node:fs";
import path from "node:path";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installQQBotRuntimeForStateTests,
  resetQQBotStateTestRuntime,
} from "../../test-support/runtime.js";
import type { RefIndexEntry } from "./types.js";

const tempWorkspaces: TempWorkspaceSync[] = [];

function refIndexFile(homeDir: string): string {
  return path.join(homeDir, ".openclaw", "qqbot", "data", "ref-index.jsonl");
}

async function useMockHome(homeDir: string): Promise<void> {
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return {
      ...actual,
      default: { ...actual, homedir: () => homeDir },
      homedir: () => homeDir,
    };
  });
}

function entry(content = "hello"): RefIndexEntry {
  return {
    content,
    senderId: "user-1",
    senderName: "User",
    timestamp: Date.now(),
    isBot: false,
  };
}

describe("engine/ref/store", () => {
  beforeEach(async () => {
    vi.resetModules();
    const stateWorkspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "qqbot-state-",
    });
    const homeWorkspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "qqbot-home-",
    });
    tempWorkspaces.push(stateWorkspace, homeWorkspace);
    const stateDir = stateWorkspace.dir;
    const homeDir = homeWorkspace.dir;
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("HOME", homeDir);
    await useMockHome(homeDir);
    installQQBotRuntimeForStateTests(stateDir);
  });

  afterEach(() => {
    resetQQBotStateTestRuntime();
    vi.doUnmock("node:os");
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const workspace of tempWorkspaces.splice(0)) {
      workspace.cleanup();
    }
  });

  it("round-trips ref-index rows through SQLite without writing JSONL", async () => {
    const { getRefIndex, setRefIndex } = await import("./store.js");
    const homeDir = process.env.HOME!;

    setRefIndex("ref-1", entry("from-sqlite"));

    expect(getRefIndex("ref-1")?.content).toBe("from-sqlite");
    expect(fs.existsSync(refIndexFile(homeDir))).toBe(false);
  });

  it("omits undefined optional fields before writing to SQLite", async () => {
    const { getRefIndex, setRefIndex } = await import("./store.js");

    setRefIndex("ref-optional", {
      content: "plain inbound",
      senderId: "user-1",
      senderName: undefined,
      timestamp: Date.now(),
      isBot: undefined,
      attachments: [
        {
          type: "image",
          filename: undefined,
          contentType: undefined,
          transcript: undefined,
          localPath: "/tmp/image.png",
        },
      ],
    });

    expect(getRefIndex("ref-optional")).toEqual({
      content: "plain inbound",
      senderId: "user-1",
      timestamp: expect.any(Number),
      attachments: [{ type: "image", localPath: "/tmp/image.png" }],
    });
  });

  it("keeps ref-index persistence best-effort when SQLite is unavailable", async () => {
    resetQQBotStateTestRuntime();
    const { getRefIndex, setRefIndex } = await import("./store.js");

    expect(() => setRefIndex("ref-unavailable", entry("ignored"))).not.toThrow();
    expect(getRefIndex("ref-unavailable")).toBeNull();
  });
});
