import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  formatSqliteSessionFileMarker,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRuntimeParityCell } from "./runtime-parity.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  await tempDirs.cleanup();
});

async function seedForcedRuntimeTranscript(params: {
  messages: Array<Record<string, unknown>>;
  sessionId: string;
}) {
  const tempRoot = await tempDirs.makeTempDir("openclaw-qa-forced-runtime-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
  const sessionKey = `agent:qa:${params.sessionId}`;
  const storePath = resolveStorePath(undefined, { agentId: "qa", env });
  await upsertSessionEntry({
    agentId: "qa",
    env,
    sessionKey,
    storePath,
    entry: {
      sessionId: params.sessionId,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "qa",
        sessionId: params.sessionId,
        storePath,
      }),
      updatedAt: 100,
    },
  });
  for (const [index, message] of params.messages.entries()) {
    await appendSessionTranscriptMessageByIdentity({
      agentId: "qa",
      env,
      sessionId: params.sessionId,
      sessionKey,
      storePath,
      now: index + 1,
      message: message as never,
    });
  }
  return tempRoot;
}

function stubEmptyMockRequests() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } })),
  );
}

async function captureForcedCodexCell(params: { logs?: () => string; tempRoot: string }) {
  return captureRuntimeParityCell({
    runtime: "codex",
    gateway: { tempRoot: params.tempRoot, ...(params.logs ? { logs: params.logs } : {}) },
    mockBaseUrl: "http://127.0.0.1:43123",
    scenarioResult: { status: "pass" },
    wallClockMs: 10,
  });
}

describe("runtime parity forced runtime observer", () => {
  it("ignores Codex mirror records and shared logs without an OpenClaw selection", async () => {
    const tempRoot = await seedForcedRuntimeTranscript({
      sessionId: "forced-codex-embedded-runtime",
      messages: [
        { role: "user", content: "runtime isolation check" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Codex mirror" }],
          provider: "openai",
          api: "openai-responses",
          stopReason: "stop",
          __openclaw: { mirrorOrigin: "codex-app-server" },
        },
      ],
    });
    stubEmptyMockRequests();

    const cell = await captureForcedCodexCell({
      tempRoot,
      logs: () => "[agent/embedded] fallback runner entered",
    });

    expect(cell.runtimeErrorClass).toBeUndefined();
  });

  it("fails a forced-Codex mock cell that selects the OpenClaw fallback", async () => {
    const tempRoot = await seedForcedRuntimeTranscript({
      sessionId: "forced-codex-openclaw-selection",
      messages: [{ role: "user", content: "runtime isolation check" }],
    });
    stubEmptyMockRequests();

    const cell = await captureForcedCodexCell({
      tempRoot,
      logs: () =>
        "agent harness selected requested=codex selected=openclaw reason=plugin_declared_fallback_openclaw",
    });

    expect(cell.runtimeErrorClass).toBe("forced-codex-embedded-runtime");
  });

  it("fails a forced-Codex mock cell containing any unmirrored Responses record", async () => {
    const tempRoot = await seedForcedRuntimeTranscript({
      sessionId: "forced-codex-openai-egress",
      messages: [
        { role: "user", content: "runtime isolation check" },
        {
          role: "assistant",
          content: [],
          provider: "openai",
          api: "openai-responses",
          stopReason: "stop",
        },
      ],
    });
    stubEmptyMockRequests();

    const cell = await captureForcedCodexCell({ tempRoot });

    expect(cell.runtimeErrorClass).toBe("forced-codex-embedded-runtime");
  });
});
