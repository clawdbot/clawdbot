/**
 * Real-process proof for session-less CLI history delivery.
 *
 * Every other cli-runner suite mocks the process supervisor, so none of them show
 * what an actual child receives. This one spawns a real node process as the CLI
 * backend and reads back exactly what landed on its stdin.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  replaceSessionEntrySync,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db-cache.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { runCliAgent } from "./cli-runner.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  cliBackendsTesting.resetDepsForTest?.();
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function createRealCliSession() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-real-")));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const hadStateDir = Object.hasOwn(process.env, "OPENCLAW_STATE_DIR");
  process.env.OPENCLAW_STATE_DIR = dir;
  const sessionTarget: SessionTranscriptRuntimeTarget = {
    agentId: "main",
    sessionId: "session-real",
    sessionKey: "agent:main:main",
    storePath: path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  replaceSessionEntrySync(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 0 });
  const seeded = appendTranscriptEventSync(sessionTarget, {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionTarget.sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: dir,
  });
  if (!seeded.ok) {
    throw new Error("could not initialize real CLI session transcript");
  }
  cleanups.push(() => {
    // The run opens both the agent transcript and the shared state DB; Windows keeps
    // the temp dir locked until each handle is released.
    closeOpenClawAgentDatabaseByPath(sessionTarget.storePath);
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(dir, { recursive: true, force: true });
    if (hadStateDir) {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
  });
  return { dir, sessionTarget };
}

function appendMessage(
  sessionTarget: SessionTranscriptRuntimeTarget,
  cwd: string,
  entry: { id: string; parentId: string | null; timestamp: string; message: unknown },
) {
  const appended = appendTranscriptMessageSync(sessionTarget, {
    cwd,
    eventId: entry.id,
    parentId: entry.parentId,
    now: Date.parse(entry.timestamp),
    message: entry.message,
  });
  if (!appended.ok || !appended.value) {
    throw new Error("could not append real CLI transcript message");
  }
}

test("a real session-less CLI child receives prior conversation and the current ask once", async () => {
  const { dir, sessionTarget } = createRealCliSession();
  const stdinReceipt = path.join(dir, "cli-stdin-receipt.txt");
  // A real CLI stand-in: drain stdin, record it verbatim, then answer on stdout.
  const cliScript = path.join(dir, "fake-cli.cjs");
  fs.writeFileSync(
    cliScript,
    [
      "let received = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { received += chunk; });",
      "process.stdin.on('end', () => {",
      `  require('node:fs').writeFileSync(${JSON.stringify(stdinReceipt)}, received);`,
      "  process.stdout.write('acknowledged');",
      "  process.exit(0);",
      "});",
    ].join("\n"),
  );

  appendMessage(sessionTarget, dir, {
    id: "real-turn-1-user",
    parentId: null,
    timestamp: "2020-01-02T03:04:05.000Z",
    message: { role: "user", content: "what is the capital of France", timestamp: 1 },
  });
  appendMessage(sessionTarget, dir, {
    id: "real-turn-1-assistant",
    parentId: "real-turn-1-user",
    timestamp: "2020-01-02T03:04:06.000Z",
    message: { role: "assistant", content: "Paris is the capital of France", timestamp: 2 },
  });

  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "anthropic",
        modelProvider: "claude-cli",
        bundleMcp: false,
        config: {
          command: process.execPath,
          args: [cliScript],
          output: "text",
          input: "stdin",
          sessionMode: "none",
          reseedFromRawTranscriptWhenUncompacted: true,
        },
      },
    ],
  });

  await runCliAgent({
    admittedRunContext: createTestAdmittedRunContext("run-real-1"),
    sessionId: sessionTarget.sessionId,
    sessionKey: sessionTarget.sessionKey,
    sessionTarget,
    sessionFile: sessionTarget.sessionKey,
    workspaceDir: dir,
    prompt: "and what about Germany",
    provider: "claude-cli",
    model: "opus",
    timeoutMs: 30_000,
    runId: "run-real-1",
    config: {},
  });

  const delivered = fs.readFileSync(stdinReceipt, "utf8");

  // Turn one actually reached the child process, not just prepare's return value.
  expect(delivered).toContain("what is the capital of France");
  expect(delivered).toContain("Paris is the capital of France");
  // The current ask is present, and present exactly once - the persisted copy of
  // this same turn must not be replayed back as history.
  expect(delivered).toContain("and what about Germany");
  expect(delivered.split("and what about Germany").length - 1).toBe(1);
});
