// Verifies last-session persistence and lookup for TUI launch.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  buildTuiLastSessionScopeKey,
  clearTuiLastSessionPointers,
  readTuiLastSessionKey,
  resolveRememberedTuiSessionKey,
  writeTuiLastSessionKey,
} from "./tui-last-session.js";

const tempDirs: string[] = [];

async function makeTempStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-last-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
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
    await expect(fs.stat(path.join(stateDir, "tui", "last-session.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    closeOpenClawStateDatabaseForTest();
    await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBe("agent:main:tui-123");
  });

  it("atomically preserves concurrent updates to independent scopes", async () => {
    const stateDir = await makeTempStateDir();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeTuiLastSessionKey({
          scopeKey: index % 2 === 0 ? "terminal" : "remote",
          sessionKey: `agent:main:tui-${index}`,
          stateDir,
        }),
      ),
    );

    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:tui-38",
    );
    await expect(readTuiLastSessionKey({ scopeKey: "remote", stateDir })).resolves.toBe(
      "agent:main:tui-39",
    );
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

  it("does not persist or restore heartbeat sessions", async () => {
    const stateDir = await makeTempStateDir();
    const scopeKey = buildTuiLastSessionScopeKey({
      connectionUrl: "ws://127.0.0.1:18789",
      agentId: "main",
      sessionScope: "per-sender",
    });

    await writeTuiLastSessionKey({
      scopeKey,
      sessionKey: "agent:main:telegram:direct:123:heartbeat",
      stateDir,
    });

    await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBeNull();
    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:telegram:direct:123:heartbeat",
        currentAgentId: "main",
        sessions: [{ key: "agent:main:telegram:direct:123:heartbeat" }],
      }),
    ).toBeNull();
  });

  it("does not restore heartbeat-origin sessions when resolving a remembered key", () => {
    const sessions = [
      {
        key: "agent:main:main",
        origin: { provider: "heartbeat", surface: "heartbeat" },
      },
      { key: "agent:main:tui-123" },
    ];

    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:main",
        currentAgentId: "main",
        sessions,
      }),
    ).toBeNull();
  });

  it("clears only pointers owned by a retired session", async () => {
    const stateDir = await makeTempStateDir();
    await writeTuiLastSessionKey({
      scopeKey: "terminal",
      sessionKey: "agent:main:main",
      stateDir,
    });
    await writeTuiLastSessionKey({
      scopeKey: "remote",
      sessionKey: "agent:main:telegram:thread",
      stateDir,
    });

    expect(
      clearTuiLastSessionPointers({
        stateDir,
        sessionKeys: new Set(["agent:main:main"]),
      }),
    ).toBe(1);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBeNull();
    await expect(readTuiLastSessionKey({ scopeKey: "remote", stateDir })).resolves.toBe(
      "agent:main:telegram:thread",
    );
  });
});
