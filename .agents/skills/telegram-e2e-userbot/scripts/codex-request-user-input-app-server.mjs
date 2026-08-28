#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";

const requestLog =
  process.env.OPENCLAW_CODEX_REQUEST_USER_INPUT_LOG ||
  "/tmp/openclaw-codex-request-user-input.ndjson";
let turnCount = 0;
const pendingQuestions = new Map();
let activeTurn = null;
let threadMode = "request-user-input";

function append(message) {
  fs.appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
}

function emit(message) {
  append({ direction: "out", message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function threadStartResult(params) {
  const now = Date.now();
  const cwd = params?.cwd ?? process.cwd();
  return {
    thread: {
      id: "thread-telegram-request-user-input",
      sessionId: "session-telegram-request-user-input",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      path: null,
      cwd,
      cliVersion: "0.147.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: params?.model ?? "gpt-5.5",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: params?.approvalPolicy ?? "never",
    approvalsReviewer: params?.approvalsReviewer ?? "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  };
}

function completeQuestion(questionId, response) {
  const pending = pendingQuestions.get(questionId);
  if (!pending) return false;
  pendingQuestions.delete(questionId);
  const selected = response?.result?.answers?.mode?.answers?.[0] ?? "EMPTY";
  const text = `CODEX_REQUEST_USER_INPUT_ANSWER=${selected}`;
  emit({
    method: "item/completed",
    params: {
      threadId: pending.threadId,
      turnId: pending.turnId,
      item: { id: `answer-${pending.turnId}`, type: "agentMessage", text },
    },
  });
  emit({
    method: "turn/completed",
    params: {
      threadId: pending.threadId,
      turnId: pending.turnId,
      turn: { id: pending.turnId, status: "completed" },
    },
  });
  return true;
}

function inputText(params) {
  return (params?.input ?? [])
    .map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

function resolveMode(params) {
  const text = inputText(params);
  if (text.includes("OPENCLAW_E2E_CODEX_COMMENTARY")) return "commentary";
  if (text.includes("OPENCLAW_E2E_CODEX_LONG_TURN")) return "long-turn";
  if (text.includes("OPENCLAW_E2E_CODEX_EXPECTED_CHECK")) return "expected-check";
  return threadMode;
}

function emitAgentMessage(turnId, id, text, phase) {
  const item = { id, type: "agentMessage", text, phase };
  emit({
    method: "item/started",
    params: { threadId: "thread-telegram-request-user-input", turnId, item: { ...item, text: "" } },
  });
  emit({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-telegram-request-user-input", turnId, itemId: id, delta: text },
  });
  emit({
    method: "item/completed",
    params: { threadId: "thread-telegram-request-user-input", turnId, item },
  });
  return item;
}

function completeCommentaryTurn(turnId) {
  emitAgentMessage(turnId, `commentary-${turnId}`, "CODEX_COMMENTARY_VISIBLE", "commentary");
  const delayMs = Number(process.env.OPENCLAW_CODEX_FIXTURE_FINAL_DELAY_MS || 6_000);
  setTimeout(() => {
    if (activeTurn?.turnId !== turnId) return;
    const finalItem = emitAgentMessage(
      turnId,
      `final-${turnId}`,
      "CODEX_COMMENTARY_FINAL",
      "finalAnswer",
    );
    emit({
      method: "turn/completed",
      params: {
        threadId: "thread-telegram-request-user-input",
        turnId,
        turn: { id: turnId, status: "completed", items: [finalItem] },
      },
    });
    activeTurn = null;
  }, delayMs);
}

function completeExpectedCheckTurn(turnId) {
  const started = {
    id: `command-${turnId}`,
    type: "commandExecution",
    command: "grep missing-pattern fixture.txt",
    cwd: process.cwd(),
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  emit({
    method: "item/started",
    params: { threadId: "thread-telegram-request-user-input", turnId, item: started },
  });
  emit({
    method: "item/completed",
    params: {
      threadId: "thread-telegram-request-user-input",
      turnId,
      item: {
        ...started,
        status: "failed",
        aggregatedOutput: "",
        exitCode: 1,
        durationMs: 8,
      },
    },
  });
  const finalItem = emitAgentMessage(
    turnId,
    `final-${turnId}`,
    "EXPECTED_NO_MATCH_IS_OK",
    "finalAnswer",
  );
  emit({
    method: "turn/completed",
    params: {
      threadId: "thread-telegram-request-user-input",
      turnId,
      turn: { id: turnId, status: "completed", items: [finalItem] },
    },
  });
  activeTurn = null;
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  append({ direction: "in", message });
  if (message.method === undefined && message.id !== undefined) {
    completeQuestion(String(message.id), message);
    return;
  }
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    emit({
      id: message.id,
      result: {
        protocolVersion: "2",
        serverInfo: { name: "openclaw-telegram-e2e", version: "0.147.0" },
        userAgent: "openclaw-telegram-e2e/0.147.0 (test)",
      },
    });
    return;
  }
  if (message.method === "thread/start") {
    emit({ id: message.id, result: threadStartResult(message.params) });
    return;
  }
  if (message.method === "turn/interrupt") {
    emit({ id: message.id, result: {} });
    if (activeTurn) {
      emit({
        method: "turn/completed",
        params: {
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          turn: { id: activeTurn.turnId, status: "interrupted", items: [] },
        },
      });
      activeTurn = null;
    }
    return;
  }
  if (message.method === "turn/start") {
    turnCount += 1;
    const turnId = `turn-telegram-request-user-input-${turnCount}`;
    threadMode = resolveMode(message.params);
    activeTurn = { threadId: "thread-telegram-request-user-input", turnId };
    const questionId = `request-user-input-${turnCount}`;
    emit({
      id: message.id,
      result: {
        turn: {
          id: turnId,
          status: "inProgress",
          items: [],
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    });
    if (threadMode === "commentary") {
      completeCommentaryTurn(turnId);
      return;
    }
    if (threadMode === "expected-check") {
      completeExpectedCheckTurn(turnId);
      return;
    }
    if (threadMode === "long-turn") return;
    pendingQuestions.set(questionId, {
      threadId: "thread-telegram-request-user-input",
      turnId,
    });
    emit({
      id: questionId,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-telegram-request-user-input",
        turnId,
        itemId: `question-${turnCount}`,
        isBlocking: true,
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Fast", description: "Use less reasoning" },
              { label: "Deep", description: "Use more reasoning" },
            ],
          },
        ],
      },
    });
    return;
  }
  emit({ id: message.id, result: {} });
});
