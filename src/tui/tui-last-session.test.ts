import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTuiLastSessionScopeKey,
  readTuiLastSessionKey,
  resolveRememberedTuiSessionKey,
  resolveTuiLastSessionStatePath,
  writeTuiLastSessionKey,
} from "./tui-last-session.js";

const tempDirs: string[] = [];

async function makeTempStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-last-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("tui last session state", () => {
  it("persists the last session under a scoped hashed key", async () => {
    const stateDir = await makeTempStateDir();
    const scopeKey = buildTuiLastSessionScopeKey({
      connectionUrl: "ws://127.0.0.1:18789",
      agentId: "Main",
      sessionScope: "per-sender",
    });

    await writeTuiLastSessionKey({
      scopeKey,
      sessionKey: "agent:main:tui-123",
      stateDir,
    });

    await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBe("agent:main:tui-123");
    const raw = await fs.readFile(resolveTuiLastSessionStatePath(stateDir), "utf8");
    expect(raw).not.toContain("127.0.0.1");
  });

  it("restores only a remembered session that still belongs to the current agent", () => {
    const sessions = [
      { key: "agent:main:main" },
      { key: "agent:main:tui-123" },
      { key: "agent:ops:tui-999" },
    ];

    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:tui-123",
        currentAgentId: "main",
        sessions,
      }),
    ).toBe("agent:main:tui-123");
    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:ops:tui-999",
        currentAgentId: "main",
        sessions,
      }),
    ).toBeNull();
    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:missing",
        currentAgentId: "main",
        sessions,
      }),
    ).toBeNull();
  });
});
