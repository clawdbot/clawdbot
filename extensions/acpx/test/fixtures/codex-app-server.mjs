#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

let nextRequestId = 1;
let nextTurnId = 1;
const pending = new Map();
const tracePath = process.env.OPENCLAW_ACPX_PROCESS_FIXTURE_TRACE;
let activeTurn = null;
const afterResponseCallback = Symbol("afterResponseCallback");

function trace(method, params) {
  if (tracePath) {
    fs.appendFileSync(tracePath, `${JSON.stringify({ method, turnId: params.turnId })}\n`, "utf8");
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  write({ method, params });
}

function request(method, params) {
  const id = `fixture-${nextRequestId++}`;
  write({ id, method, params });
  const response = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  return { id, response };
}

function invalidRequest(message) {
  const error = new Error(message);
  error.code = -32600;
  return error;
}

function deferUntilAfterResponse(result, callback) {
  let pendingCallback = callback;
  return {
    result,
    [afterResponseCallback]() {
      const consume = pendingCallback;
      pendingCallback = null;
      consume?.();
    },
  };
}

const model = {
  id: "gpt-5.6-luna",
  model: "gpt-5.6-luna",
  displayName: "GPT-5.6 Luna",
  description: "Process-fixture model",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [],
  inputModalities: ["text"],
};

async function handle(method, params) {
  if (method !== "turn/start") {
    trace(method, params);
  }
  if (method === "initialize") {
    return { userAgent: "openclaw-acpx-process-fixture", codexHome: process.cwd() };
  }
  if (method === "account/read") {
    return { requiresOpenaiAuth: false, account: null };
  }
  if (method === "config/read") {
    return { config: {} };
  }
  if (method === "skills/list") {
    return { data: [] };
  }
  if (method === "model/list") {
    return { data: [model], nextCursor: null };
  }
  if (method === "thread/start") {
    return {
      thread: { id: "thread-process", name: "Process fixture", preview: "", cwd: process.cwd() },
      model: model.id,
      modelProvider: "openai",
      reasoningEffort: "medium",
      serviceTier: null,
    };
  }
  if (method === "turn/start") {
    if (activeTurn?.terminalStatus === null) {
      throw invalidRequest("a turn is already active");
    }
    const turnId = `turn-process-${nextTurnId++}`;
    trace(method, { turnId });
    const turn = { id: turnId, items: [], status: "inProgress", error: null };
    const state = {
      threadId: params.threadId,
      turn,
      terminalStatus: null,
      pendingElicitationRequestId: null,
    };
    activeTurn = state;
    queueMicrotask(() => {
      void (async () => {
        notify("turn/started", { threadId: params.threadId, turn });
        const elicitation = request("item/tool/requestUserInput", {
          threadId: params.threadId,
          turnId,
          itemId: "request_user_input",
          questions: [
            {
              id: "question",
              header: "Answer",
              question: "Choose a value",
              isOther: false,
              isSecret: false,
              options: null,
            },
          ],
          isBlocking: true,
          autoResolutionMs: null,
        });
        state.pendingElicitationRequestId = elicitation.id;
        const answers = await elicitation.response;
        if (activeTurn !== state || state.terminalStatus !== null) {
          return;
        }
        state.pendingElicitationRequestId = null;
        const text = JSON.stringify(answers);
        const item = { type: "agentMessage", id: "message-process", text };
        state.turn = { ...turn, items: [item], status: "completed" };
        state.terminalStatus = "completed";
        notify("item/agentMessage/delta", {
          threadId: params.threadId,
          turnId,
          itemId: item.id,
          delta: text,
        });
        notify("item/completed", { threadId: params.threadId, turnId, item });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: state.turn,
        });
      })().catch(() => {
        process.stderr.write("codex app-server fixture turn failed\n");
      });
    });
    return { turn };
  }
  if (method === "turn/interrupt") {
    const state = activeTurn;
    if (
      !state ||
      state.terminalStatus !== null ||
      state.threadId !== params.threadId ||
      state.turn.id !== params.turnId
    ) {
      throw invalidRequest("no matching active turn to interrupt");
    }
    const pendingElicitationRequestId = state.pendingElicitationRequestId;
    const interruptedTurn = { ...state.turn, items: [], status: "interrupted" };
    // Terminalize before settling elicitation so its continuation cannot win the race.
    state.terminalStatus = "interrupted";
    state.turn = interruptedTurn;
    state.pendingElicitationRequestId = null;
    if (pendingElicitationRequestId) {
      const waiter = pending.get(pendingElicitationRequestId);
      pending.delete(pendingElicitationRequestId);
      waiter?.resolve(undefined);
    }
    return deferUntilAfterResponse({}, () => {
      notify("turn/completed", {
        threadId: state.threadId,
        turn: interruptedTurn,
      });
    });
  }
  if (["thread/unsubscribe", "thread/archive"].includes(method)) {
    return {};
  }
  throw new Error(`unsupported fixture method: ${method}`);
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message && "id" in message && !("method" in message)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      waiter?.reject(new Error(message.error.message ?? "fixture request failed"));
    } else {
      waiter?.resolve(message.result);
    }
    return;
  }
  if (!message || typeof message.method !== "string" || !("id" in message)) {
    return;
  }
  try {
    const handled = await handle(message.method, message.params ?? {});
    const afterResponse = handled?.[afterResponseCallback];
    const result = afterResponse ? handled.result : handled;
    write({ id: message.id, result });
    afterResponse?.();
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error && Number.isInteger(error.code)
        ? error.code
        : -32601;
    write({
      id: message.id,
      error: { code, message: error instanceof Error ? error.message : String(error) },
    });
  }
});
