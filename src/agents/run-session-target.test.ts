import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
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
    });
    expect(parseSqliteSessionFileMarker(target.sessionFile)).toEqual({
      agentId: "helper",
      sessionId: "test-run",
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
    expect(target.agentId).toBe("helper");
    expect(parseSqliteSessionFileMarker(target.sessionFile)).toEqual({
      agentId: "helper",
      sessionId: "helper-session",
      storePath: helperStorePath,
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
