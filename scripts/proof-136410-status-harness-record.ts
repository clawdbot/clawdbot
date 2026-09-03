/**
 * Real behavior proof for PR #136410 — the status Runtime line must distinguish a
 * session's recorded runtime from the runtime that owns the next turn, and must
 * NOT invent a transition between two ids that render as the same runtime.
 *
 * What is REAL here:
 *  - The session entries are written to a real SQLite session store in a temp
 *    `OPENCLAW_STATE_DIR` via the production `upsertSessionEntryCore`, then read
 *    back with the production `loadSessionEntryReadOnly`. The retired
 *    `agentHarnessId: "codex-cli"` is asserted to survive that round trip, so the
 *    scenario is driven by a genuinely persisted id rather than an inline literal.
 *  - The rendering is the real `buildStatusMessage` — the same function `/status`
 *    calls — which resolves the Runtime line through the real
 *    `resolveAgentRuntimeLabel`.
 *
 * Stubbed: only the temp state dir. Nothing between the store and the rendered
 * line is faked.
 *
 * Scenarios:
 *  1. RETIRED-ALIAS (the regression): persisted `codex-cli`, live runtime `codex`.
 *     `AGENT_RUNTIME_LABELS` renders both as "OpenAI Codex", so annotating a
 *     transition would read `OpenAI Codex (previous runtime: OpenAI Codex)` —
 *     a runtime change that never happened. Must render a bare `OpenAI Codex`.
 *  2. REAL-TRANSITION control: persisted `openclaw`, live runtime `codex`. Must
 *     still annotate `(previous runtime: OpenClaw Default)`.
 *  3. SESSION-PIN control: same as 2 but `modelSelectionLocked`, so the
 *     relationship word must be `session pin`.
 *  4. RETIRED-ALIAS REAL-TRANSITION control: persisted `codex-cli`, live runtime
 *     `claude-cli`. The alias must not swallow a genuine transition — this pins
 *     that the fix suppresses only same-label pairs.
 *
 * Run: pnpm tsx scripts/proof-136410-status-harness-record.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

// Heartbeat from a worker thread: a main-thread setInterval does not fire during
// a synchronous tsx/jiti compile, and a silent proof reads as a hung proof.
const heartbeat = new Worker(
  `const { writeSync } = require("node:fs");
   let n = 0;
   setInterval(() => { writeSync(1, "[proof] still running (" + (++n) * 5 + "s)\\n"); }, 5000).unref?.();
   setInterval(() => {}, 1 << 30);`,
  { eval: true, stdout: false },
);

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed += 1;
    console.log(`  PASS ${label}: ${JSON.stringify(actual)}`);
  } else {
    failed += 1;
    console.log(
      `  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log("proof-136410: status Runtime line, persisted harness id vs live runtime");

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-136410-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "sessions.sqlite");

  const { upsertSessionEntryCore } = await import("../src/config/sessions/session-accessor.js");
  const { loadSessionEntryReadOnly } =
    await import("../src/config/sessions/session-accessor.sqlite-entry.js");
  const { buildStatusMessage } = await import("../src/status/status-message.js");

  async function persistAndRender(params: {
    label: string;
    sessionKey: string;
    persistedHarnessId: string;
    resolvedHarness: string;
    modelSelectionLocked?: boolean;
  }): Promise<string> {
    console.log(`\n=== ${params.label} ===`);
    await upsertSessionEntryCore(
      { sessionKey: params.sessionKey, storePath },
      {
        sessionId: params.sessionKey,
        updatedAt: Date.now(),
        agentHarnessId: params.persistedHarnessId,
        ...(params.modelSelectionLocked ? { modelSelectionLocked: true } : {}),
      },
    );

    // Read the entry back out of SQLite: the scenario must be driven by what the
    // store actually holds, not by the object we just handed it.
    const stored = loadSessionEntryReadOnly({ sessionKey: params.sessionKey, storePath });
    check(
      "persisted agentHarnessId round-tripped",
      stored?.agentHarnessId,
      params.persistedHarnessId,
    );
    if (!stored) {
      throw new Error(`session entry ${params.sessionKey} did not persist`);
    }

    const message = buildStatusMessage({
      agent: { model: "openai/gpt-5.4" },
      resolvedHarness: params.resolvedHarness,
      sessionEntry: stored,
      sessionKey: "agent:main:direct:redacted",
      sessionScope: "per-sender",
      queue: { mode: "steer", depth: 0 },
      modelAuth: "oauth",
    });
    const runtimeLine = message.split("\n").find((line) => line.includes("Runtime:")) ?? "";
    console.log(`  rendered: ${runtimeLine.trim()}`);
    return runtimeLine;
  }

  // 1. The regression: a retired id and the current id render as one runtime.
  const retired = await persistAndRender({
    label: "RETIRED-ALIAS: persisted codex-cli, live runtime codex",
    sessionKey: "agent:main:retired-alias",
    persistedHarnessId: "codex-cli",
    resolvedHarness: "codex",
  });
  check(
    "renders the runtime once, with no invented transition",
    retired.includes("OpenAI Codex"),
    true,
  );
  check("no 'previous runtime' annotation", retired.includes("previous runtime"), false);
  check("no 'session pin' annotation", retired.includes("session pin"), false);
  check(
    "specifically not the self-referential label",
    retired.includes("OpenAI Codex (previous runtime: OpenAI Codex)"),
    false,
  );

  // 2. A genuine transition must still be reported.
  const transition = await persistAndRender({
    label: "REAL-TRANSITION control: persisted openclaw, live runtime codex",
    sessionKey: "agent:main:real-transition",
    persistedHarnessId: "openclaw",
    resolvedHarness: "codex",
  });
  check(
    "annotates the real transition",
    transition.includes("Runtime: OpenAI Codex (previous runtime: OpenClaw Default)"),
    true,
  );

  // 3. A locked session names the relationship differently.
  const locked = await persistAndRender({
    label: "SESSION-PIN control: persisted openclaw, live runtime codex, locked",
    sessionKey: "agent:main:session-pin",
    persistedHarnessId: "openclaw",
    resolvedHarness: "codex",
    modelSelectionLocked: true,
  });
  check(
    "annotates the pin as a session pin",
    locked.includes("Runtime: OpenAI Codex (session pin: OpenClaw Default)"),
    true,
  );

  // 4. The alias must not swallow a genuine transition away from Codex.
  const aliasTransition = await persistAndRender({
    label: "RETIRED-ALIAS REAL-TRANSITION control: persisted codex-cli, live runtime claude-cli",
    sessionKey: "agent:main:alias-transition",
    persistedHarnessId: "codex-cli",
    resolvedHarness: "claude-cli",
  });
  check(
    "still annotates a real transition from the retired id",
    aliasTransition.includes("Runtime: Claude CLI (previous runtime: OpenAI Codex)"),
    true,
  );

  console.log(`\n${passed} passed, ${failed} failed (${passed + failed} assertions)`);
  if (failed > 0) {
    console.log("Runtime assertions FAILED.");
    await heartbeat.terminate();
    process.exit(1);
  }
  console.log("All runtime assertions passed.");
  await heartbeat.terminate();
  process.exit(0);
}

main().catch(async (error: unknown) => {
  console.error(error);
  await heartbeat.terminate();
  process.exit(1);
});
