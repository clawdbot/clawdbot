import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const fixturePath = new URL("./triage-mock-openai.mjs", import.meta.url);

async function startFixture(scenario) {
  const server = spawn(process.execPath, [fixturePath.pathname], {
    env: { ...process.env, MOCK_PORT: "19993", E2E_TRIAGE_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  for (let attempt = 0; attempt < 100 && !output.includes("mock-openai listening"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(output, /mock-openai listening/u);
  return server;
}

async function stopFixture(server) {
  server.kill("SIGTERM");
  await once(server, "exit");
}

async function post(body, pathname = "/v1/responses") {
  return fetch(`http://127.0.0.1:19993${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("emits interleaved visible and reasoning blocks", async () => {
  const server = await startFixture("interleaved-monologue");
  try {
    const response = await post({ model: "gpt-5.5", messages: [] }, "/v1/chat/completions");
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /response\.output_text/u);
    assert.match(text, /reasoning\.text/u);
    assert.match(text, /PRIVATE_MONOLOGUE/u);
    assert.match(text, /PUBLIC_FINAL/u);
  } finally {
    await stopFixture(server);
  }
});

test("ends an empty assistant turn at tool use", async () => {
  const server = await startFixture("incomplete-tool-use");
  try {
    const response = await post({ model: "gpt-5.5", messages: [] }, "/v1/chat/completions");
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /"finish_reason":"tool_calls"/u);
    assert.doesNotMatch(text, /tool_calls":\[/u);
  } finally {
    await stopFixture(server);
  }
});

test("emits the recoverable double-wrapped Tool Search shape", async () => {
  const server = await startFixture("tool-search-double-wrap");
  try {
    const response = await post({ model: "gpt-5.5", input: [] });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /"name":"tool_call"/u);
    assert.match(text, /\\"args\\":\{\\"id\\":\\"session_status\\"/u);
  } finally {
    await stopFixture(server);
  }
});

test("fails primary and succeeds fallback", async () => {
  const server = await startFixture("model-fallback-room");
  try {
    const primary = await post({ model: "primary", input: [] });
    assert.equal(primary.status, 503);
    assert.match(await primary.text(), /PRIMARY_ROUTE_UNAVAILABLE/u);
    const fallback = await post({ model: "fallback", input: [] });
    assert.equal(fallback.status, 200);
    assert.match(await fallback.text(), /FALLBACK_ROUTE_OK/u);
  } finally {
    await stopFixture(server);
  }
});

test("spawns before yielding with a user-facing message", async () => {
  const server = await startFixture("yield-message-drop");
  try {
    const spawn = await post({ tools: [{ name: "sessions_yield" }], input: [] });
    assert.match(await spawn.text(), /"name":"sessions_spawn"/u);
    const yielded = await post({
      tools: [{ name: "sessions_yield" }],
      input: [{ type: "function_call_output", output: "accepted" }],
    });
    const text = await yielded.text();
    assert.match(text, /"name":"sessions_yield"/u);
    assert.match(text, /RESEARCH_STARTED_107788/u);
  } finally {
    await stopFixture(server);
  }
});

test("emits a failed edit followed by a successful retry", async () => {
  const server = await startFixture("edit-failure-recovery");
  try {
    const failed = await post({ input: [{ type: "function_call_output", output: "written" }] });
    const failedText = await failed.text();
    assert.match(failedText, /"name":"edit"/u);
    assert.match(failedText, /beta/u);
    const recovered = await post({
      input: [
        { type: "function_call_output", output: "written" },
        { type: "function_call_output", output: "failed" },
      ],
    });
    const recoveredText = await recovered.text();
    assert.match(recoveredText, /"name":"edit"/u);
    assert.match(recoveredText, /alpha/u);
  } finally {
    await stopFixture(server);
  }
});

test("pauses after three preview deltas before the final stream value", async () => {
  const server = await startFixture("streaming-throttle");
  try {
    const startedAt = Date.now();
    const response = await post({ input: [] });
    const text = await response.text();
    assert.ok(Date.now() - startedAt >= 1_400);
    assert.equal(text.match(/response\.output_text\.delta/gu)?.length, 3);
    assert.match(text, /STREAM_FINAL_107179/u);
  } finally {
    await stopFixture(server);
  }
});

test("emits a good draft and tool before terminal NO_REPLY", async () => {
  const server = await startFixture("terminal-no-reply-drops-draft");
  try {
    const draft = await post({ input: [] });
    const draftText = await draft.text();
    assert.match(draftText, /GOOD_DRAFT_115041/u);
    assert.match(draftText, /"name":"exec"/u);
    const terminal = await post({ input: [{ type: "function_call_output", output: "tool-ok" }] });
    assert.match(await terminal.text(), /NO_REPLY/u);
  } finally {
    await stopFixture(server);
  }
});

test("ends on NO_REPLY after a successful tool and failed terminal tool", async () => {
  const server = await startFixture("terminal-failure-after-success");
  try {
    const failed = await post({
      input: [
        { type: "function_call_output", output: "written" },
        { type: "function_call_output", output: "failed" },
      ],
    });
    assert.match(await failed.text(), /NO_REPLY/u);
  } finally {
    await stopFixture(server);
  }
});

test("self-narrates cron delivery only without recipient-only guidance", async () => {
  const server = await startFixture("cron-self-narration");
  try {
    const oldPrompt = await post({
      input: [{ text: "Your response will be delivered automatically." }],
    });
    assert.match(await oldPrompt.text(), /I sent the user/u);
    const repairedPrompt = await post({
      input: [{ text: "Write only the exact user-facing message to send." }],
    });
    const repairedText = await repairedPrompt.text();
    assert.match(repairedText, /SCHEDULE_CONFIRMED_90836/u);
    assert.doesNotMatch(repairedText, /I sent the user/u);
  } finally {
    await stopFixture(server);
  }
});
