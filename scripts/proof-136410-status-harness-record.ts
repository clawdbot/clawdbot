/**
 * Proves the status runtime label with a real SQLite session row.
 *
 * Run with: node --import ./scripts/tsx.mjs scripts/proof-136410-status-harness-record.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { upsertSessionEntryCore } = await import("../src/config/sessions/session-accessor.js");
const { loadSessionEntryReadOnly } =
  await import("../src/config/sessions/session-accessor.sqlite-entry.js");
const { buildStatusMessage } = await import("../src/status/status-message.js");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proof-136410-status-"));
const storePath = path.join(tempRoot, "sessions.sqlite");

function runtimeLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.includes("Runtime:"))
      ?.trim() ?? ""
  );
}

function assertEqual(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  console.log(`PASS ${label}: ${actual}`);
}

async function persistAndRender(params: {
  sessionKey: string;
  agentHarnessId: string;
  resolvedHarness: string;
  modelSelectionLocked?: boolean;
}): Promise<string> {
  await upsertSessionEntryCore(
    { sessionKey: params.sessionKey, storePath },
    {
      sessionId: params.sessionKey,
      updatedAt: Date.now(),
      agentHarnessId: params.agentHarnessId,
      ...(params.modelSelectionLocked ? { modelSelectionLocked: true } : {}),
    },
  );
  const stored = loadSessionEntryReadOnly({ sessionKey: params.sessionKey, storePath });
  assertEqual("SQLite persisted harness", stored?.agentHarnessId ?? "", params.agentHarnessId);
  if (!stored) {
    throw new Error(`missing persisted session ${params.sessionKey}`);
  }
  return runtimeLine(
    buildStatusMessage({
      agent: { model: "openai/gpt-5.4" },
      resolvedHarness: params.resolvedHarness,
      sessionEntry: stored,
      sessionKey: params.sessionKey,
      sessionScope: "per-sender",
      queue: { mode: "steer", depth: 0 },
      modelAuth: "oauth",
    }),
  );
}

try {
  const history = await persistAndRender({
    sessionKey: "agent:main:status-history",
    agentHarnessId: "openclaw",
    resolvedHarness: "codex",
  });
  assertEqual(
    "unlocked runtime transition",
    history,
    "🤖 Runtime: OpenAI Codex (previous runtime: OpenClaw Default)",
  );

  const retiredAlias = await persistAndRender({
    sessionKey: "agent:main:status-retired-alias",
    agentHarnessId: "codex-cli",
    resolvedHarness: "codex",
  });
  assertEqual("retired alias has one operator label", retiredAlias, "🤖 Runtime: OpenAI Codex");

  const pin = await persistAndRender({
    sessionKey: "agent:main:status-pin",
    agentHarnessId: "openclaw",
    resolvedHarness: "codex",
    modelSelectionLocked: true,
  });
  assertEqual(
    "locked runtime transition",
    pin,
    "🤖 Runtime: OpenAI Codex (session pin: OpenClaw Default)",
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(`cleanup: ${fs.existsSync(tempRoot) ? "failed" : "removed"}`);
}
