#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

let nextRequestId = 1;
const pending = new Map();
const tracePath = process.env.OPENCLAW_ACPX_PROCESS_FIXTURE_TRACE;

function trace(method) {
  if (tracePath) {
    fs.appendFileSync(tracePath, `${JSON.stringify({ method })}\n`, "utf8");
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
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
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
  trace(method);
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
    const turnId = "turn-process";
    const turn = { id: turnId, items: [], status: "inProgress", error: null };
    queueMicrotask(() => {
      void (async () => {
        notify("turn/started", { threadId: params.threadId, turn });
        const answers = await request("item/tool/requestUserInput", {
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
        const text = JSON.stringify(answers);
        const item = { type: "agentMessage", id: "message-process", text };
        notify("item/agentMessage/delta", {
          threadId: params.threadId,
          turnId,
          itemId: item.id,
          delta: text,
        });
        notify("item/completed", { threadId: params.threadId, turnId, item });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { ...turn, items: [item], status: "completed" },
        });
      })().catch(() => {
        process.stderr.write("codex app-server fixture turn failed\n");
      });
    });
    return { turn };
  }
  if (["turn/interrupt", "thread/unsubscribe", "thread/archive"].includes(method)) {
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
    write({ id: message.id, result: await handle(message.method, message.params ?? {}) });
  } catch (error) {
    write({
      id: message.id,
      error: { code: -32601, message: error instanceof Error ? error.message : String(error) },
    });
  }
});
