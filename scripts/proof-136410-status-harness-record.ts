/** Real renderer proof for PR #136410. */
import assert from "node:assert/strict";
import { buildStatusMessage } from "../src/status/status-message.js";

function render(modelSelectionLocked: boolean) {
  return buildStatusMessage({
    agent: { model: "openai/gpt-5.4" },
    resolvedHarness: "codex",
    sessionEntry: {
      sessionId: modelSelectionLocked ? "locked-session" : "unlocked-session",
      updatedAt: Date.now(),
      agentHarnessId: "openclaw",
      modelSelectionLocked,
    },
    sessionKey: "agent:main:direct:redacted",
    sessionScope: "per-sender",
    queue: { mode: "steer", depth: 0 },
    modelAuth: "oauth",
  });
}

const unlocked = render(false);
const locked = render(true);

assert.match(unlocked, /Runtime: OpenAI Codex \(previous runtime: OpenClaw Default\)/);
assert.doesNotMatch(unlocked, /session pin/);
assert.match(locked, /Runtime: OpenAI Codex \(session pin: OpenClaw Default\)/);

console.log("unlocked:");
console.log(unlocked.split("\n").find((line) => line.includes("Runtime:")));
console.log("locked:");
console.log(locked.split("\n").find((line) => line.includes("Runtime:")));
console.log("\nAll runtime assertions passed.");
