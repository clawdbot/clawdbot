import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("requests native user input and completes with the selected answer", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-input-fixture-test-"));
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixturePath = fileURLToPath(
    new URL("./codex-request-user-input-app-server.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [fixturePath], {
    env: { ...process.env, OPENCLAW_CODEX_REQUEST_USER_INPUT_LOG: path.join(temp, "messages.ndjson") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  context.after(() => child.kill("SIGTERM"));
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`fixture response timed out: ${JSON.stringify(messages)}`);
  };

  send({ id: 1, method: "initialize", params: {} });
  await waitFor((message) => message.id === 1);
  send({ id: 2, method: "thread/start", params: { cwd: temp } });
  await waitFor((message) => message.id === 2);
  send({ id: 3, method: "turn/start", params: {} });
  const question = await waitFor(
    (message) => message.method === "item/tool/requestUserInput",
  );
  send({ id: question.id, result: { answers: { mode: { answers: ["Deep"] } } } });
  const completed = await waitFor((message) => message.method === "item/completed");
  assert.equal(completed.params.item.text, "CODEX_REQUEST_USER_INPUT_ANSWER=Deep");
});

test("emits protocol-faithful commentary and interrupts a held turn", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lifecycle-fixture-test-"));
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixturePath = fileURLToPath(
    new URL("./codex-request-user-input-app-server.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [fixturePath], {
    env: {
      ...process.env,
      OPENCLAW_CODEX_REQUEST_USER_INPUT_LOG: path.join(temp, "messages.ndjson"),
      OPENCLAW_CODEX_FIXTURE_FINAL_DELAY_MS: "5",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  context.after(() => child.kill("SIGTERM"));
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`fixture response timed out: ${JSON.stringify(messages)}`);
  };

  send({ id: 1, method: "turn/start", params: { input: [{ type: "text", text: "OPENCLAW_E2E_CODEX_COMMENTARY" }] } });
  const commentary = await waitFor(
    (message) => message.method === "item/completed" && message.params.item.phase === "commentary",
  );
  assert.equal(commentary.params.item.text, "CODEX_COMMENTARY_VISIBLE");
  await waitFor(
    (message) => message.method === "turn/completed" && message.params.turn.status === "completed",
  );

  send({ id: 2, method: "turn/start", params: { input: [{ type: "text", text: "OPENCLAW_E2E_CODEX_LONG_TURN" }] } });
  await waitFor((message) => message.id === 2);
  send({ id: 3, method: "turn/interrupt", params: { threadId: "thread-telegram-request-user-input" } });
  const interrupted = await waitFor(
    (message) => message.method === "turn/completed" && message.params.turn.status === "interrupted",
  );
  assert.equal(interrupted.params.turn.id, "turn-telegram-request-user-input-2");

  send({ id: 4, method: "turn/start", params: { input: [{ type: "text", text: "OPENCLAW_E2E_CODEX_EXPECTED_CHECK" }] } });
  const failedCheck = await waitFor(
    (message) => message.method === "item/completed" && message.params.item.type === "commandExecution",
  );
  assert.equal(failedCheck.params.item.exitCode, 1);
  assert.equal(failedCheck.params.item.status, "failed");
});
