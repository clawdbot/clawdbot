import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRunSessionTarget } from "./run-session-target.js";

describe("agent run session target", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-run-session-target-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves runtime identity through the run config store", async () => {
    const storePath = path.join(tempDir, "custom-sessions", "sessions.json");
    const sessionKey = "agent:helper:commitments:test-run";

    const target = await resolveAgentRunSessionTarget({
      agentId: "helper",
      config: { session: { store: storePath } } as OpenClawConfig,
      sessionId: "test-run",
      sessionKey,
    });

    expect(target).toMatchObject({
      agentId: "helper",
      sessionId: "test-run",
      sessionKey,
      storePath,
    });
  });

  it("uses the agent from an agent-scoped session key when agentId is omitted", async () => {
    const storeRoot = path.join(tempDir, "agents", "{agentId}", "sessions.json");
    const sessionKey = "agent:helper:main";

    const target = await resolveAgentRunSessionTarget({
      config: { session: { store: storeRoot } } as OpenClawConfig,
      sessionId: "helper-session",
      sessionKey,
    });

    const helperStorePath = path.join(tempDir, "agents", "helper", "sessions.json");
    expect(target).toMatchObject({
      agentId: "helper",
      sessionId: "helper-session",
      sessionKey,
      storePath: helperStorePath,
    });
  });

  it("uses the session id as the compatibility key when callers omit sessionKey", async () => {
    const storePath = path.join(tempDir, "fallback", "sessions.json");

    await expect(
      resolveAgentRunSessionTarget({
        config: { session: { store: storePath } } as OpenClawConfig,
        sessionId: "compat-session",
      }),
    ).resolves.toEqual({
      agentId: "main",
      sessionId: "compat-session",
      sessionKey: "compat-session",
      storePath,
    });
  });

  it("uses a compatibility session-file token when callers omit sessionKey", async () => {
    const storePath = path.join(tempDir, "fallback", "sessions.json");

    await expect(
      resolveAgentRunSessionTarget({
        config: { session: { store: storePath } } as OpenClawConfig,
        sessionId: "compat-session",
        sessionFile: "agent:helper:compat-session",
      }),
    ).resolves.toEqual({
      agentId: "helper",
      sessionId: "compat-session",
      sessionKey: "agent:helper:compat-session",
      storePath,
    });
  });

  it("recovers the stored key from a legacy SQLite marker", async () => {
    const storePath = path.join(tempDir, "legacy", "sessions.json");
    const sessionKey = "agent:main:dashboard:legacy-session";
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "legacy-session", updatedAt: 1 },
    );

    await expect(
      resolveAgentRunSessionTarget({
        sessionId: "legacy-session",
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "legacy-session",
          storePath,
        }),
      }),
    ).resolves.toMatchObject({ sessionKey, storePath });
  });

  it("uses the marker store for a compatible partial typed target", async () => {
    const storePath = path.join(tempDir, "legacy-partial", "sessions.json");

    await expect(
      resolveAgentRunSessionTarget({
        sessionId: "legacy-session",
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "legacy-session",
          storePath,
        }),
        sessionTarget: { agentId: "main", sessionId: "legacy-session" },
      }),
    ).resolves.toMatchObject({ agentId: "main", sessionId: "legacy-session", storePath });
  });

  it("rejects a partial typed key from another marker agent", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        sessionId: "legacy-session",
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "legacy-session",
          storePath: path.join(tempDir, "legacy.json"),
        }),
        sessionTarget: {
          sessionId: "legacy-session",
          sessionKey: "agent:worker:legacy-session",
        },
      }),
    ).rejects.toThrow("Legacy SQLite transcript marker conflicts");
  });

  it("rejects a compatibility key from another target agent", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        sessionId: "compat-session",
        sessionFile: "agent:helper:compat-session",
        sessionTarget: { agentId: "main", sessionId: "compat-session" },
      }),
    ).rejects.toThrow("Compatibility session key conflicts with the supplied agent identity");
  });

  it("does not let a partial typed target suppress file-backed rejection", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        sessionId: "legacy-session",
        sessionFile: path.join(tempDir, "legacy-session.jsonl"),
        sessionTarget: { agentId: "main", sessionId: "legacy-session" },
      }),
    ).rejects.toThrow("File-backed transcript targets are unsupported");
  });

  it("rejects a partial typed target that conflicts with a legacy marker", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        sessionId: "legacy-session",
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "legacy-session",
          storePath: path.join(tempDir, "legacy.json"),
        }),
        sessionTarget: { agentId: "worker", sessionId: "legacy-session" },
      }),
    ).rejects.toThrow("Legacy SQLite transcript marker conflicts");
  });

  it("normalizes partial typed identity before comparing a legacy marker", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        sessionId: "legacy-session",
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "legacy-session",
          storePath: path.join(tempDir, "legacy.json"),
        }),
        sessionTarget: { agentId: " main ", sessionId: " legacy-session " },
      }),
    ).resolves.toMatchObject({ agentId: "main", sessionId: "legacy-session" });
  });

  it("ignores a stale compatibility token when a typed key is present", async () => {
    const storePath = path.join(tempDir, "target", "sessions.json");

    await expect(
      resolveAgentRunSessionTarget({
        sessionId: "target-session",
        sessionFile: "agent:helper:stale",
        sessionTarget: {
          agentId: "main",
          sessionId: "target-session",
          sessionKey: "agent:main:target-session",
          storePath,
        },
      }),
    ).resolves.toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:target-session",
      storePath,
    });
  });

  it("ignores a stale legacy marker when a complete typed target is present", async () => {
    const storePath = path.join(tempDir, "target", "sessions.json");

    await expect(
      resolveAgentRunSessionTarget({
        sessionId: "old-session",
        sessionFile: `sqlite:helper:old-session:${path.join(tempDir, "old.json")}`,
        sessionTarget: {
          agentId: "main",
          sessionId: "target-session",
          sessionKey: "agent:main:target-session",
          storePath,
        },
      }),
    ).resolves.toMatchObject({
      agentId: "main",
      sessionId: "target-session",
      sessionKey: "agent:main:target-session",
      storePath,
    });
  });

  it("prefers typed runtime target identity", async () => {
    const storePath = path.join(tempDir, "target-store", "sessions.json");

    const target = await resolveAgentRunSessionTarget({
      agentId: "main",
      config: {
        session: { store: path.join(tempDir, "fallback", "sessions.json") },
      } as OpenClawConfig,
      sessionId: "legacy-session",
      sessionKey: "agent:main:legacy-session",
      sessionTarget: {
        agentId: "worker",
        sessionId: "runtime-session",
        sessionKey: "agent:worker:runtime-session",
        storePath,
      },
    });

    expect(target).toMatchObject({
      agentId: "worker",
      sessionId: "runtime-session",
      sessionKey: "agent:worker:runtime-session",
      storePath,
    });
  });
});
