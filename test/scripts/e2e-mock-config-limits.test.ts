// E2E Mock Config Limits tests cover e2e mock config limits script behavior.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { getFreePort } from "../../src/test-utils/ports.js";

const mockOpenAiPath = "scripts/e2e/mock-openai-server.mjs";
const webSearchMockPath = "scripts/e2e/lib/openai-web-search-minimal/mock-server.mjs";
const browserCdpFixturePath = "scripts/e2e/lib/browser-cdp-snapshot/fixture-server.mjs";
const configReloadAssertPath = "scripts/e2e/lib/config-reload/assert-log.mjs";
const clickClackFixturePath = "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs";
const scrubbedEnvKeys = [
  "CLICKCLACK_FIXTURE_PORT",
  "CLICKCLACK_FIXTURE_REQUEST_MAX_BYTES",
  "FIXTURE_PORT",
  "MOCK_PORT",
  "MOCK_REQUEST_LOG",
  "MOCK_RESPONSE_CHUNK_DELAY_MS",
  "MOCK_TLS_CERT",
  "MOCK_TLS_KEY",
  "OPENCLAW_CONFIG_RELOAD_LOG_MAX_READ_BYTES",
  "OPENCLAW_CONFIG_RELOAD_LOG_PATH",
  "OPENCLAW_CONFIG_RELOAD_LOG_TIMEOUT_MS",
  "OPENCLAW_MOCK_OPENAI_PORT",
  "RAW_SCHEMA_ERROR",
  "SUCCESS_MARKER",
];

function cleanEnv(env: Record<string, string>) {
  const childEnv = { ...process.env };
  for (const key of scrubbedEnvKeys) {
    delete childEnv[key];
  }
  return { ...childEnv, ...env };
}

function runScript(scriptPath: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: cleanEnv(env),
    killSignal: "SIGKILL",
    timeout: 3_000,
  });
}

async function waitForListening(child: ChildProcess, port: number, output: () => string) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`mock server did not listen on ${port}: ${output()}`));
    }, 3_000);
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    if (output().includes(`mock-openai listening on ${port}`)) {
      finish();
      return;
    }
    child.stdout?.on("data", () => {
      if (output().includes(`mock-openai listening on ${port}`)) {
        finish();
      }
    });
    child.once("exit", (code, signal) => {
      finish(new Error(`mock server exited before listening: code=${code} signal=${signal}`));
    });
  });
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    delay(1_000, undefined, { ref: false }).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    await exited;
  }
}

async function withMockServer(
  scriptPath: string,
  env: Record<string, string>,
  run: (
    baseUrl: string,
    output: {
      stderr: () => string;
      stdout: () => string;
    },
  ) => Promise<void>,
) {
  const port = await getFreePort();
  let stderr = "";
  let stdout = "";
  const child = spawn(process.execPath, [scriptPath], {
    env: cleanEnv({ ...env, MOCK_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await waitForListening(child, port, () => `${stdout}\n${stderr}`);
    await run(`http://127.0.0.1:${port}`, {
      stderr: () => stderr,
      stdout: () => stdout,
    });
  } finally {
    await stopServer(child);
  }
}

describe("mock OpenAI response markers", () => {
  const editRecoveryPath = "issue-46548-edit-recovery.txt";
  const editRecoveryTools = [
    { name: "write", parameters: { type: "object" }, type: "function" },
    { name: "edit", parameters: { type: "object" }, type: "function" },
  ];
  const editRecoveryTranscript = {
    seed: {
      name: "write",
      args: { path: editRecoveryPath, content: "before\n" },
      output: `Successfully wrote 7 bytes to ${editRecoveryPath}`,
    },
    failure: {
      name: "edit",
      args: {
        path: editRecoveryPath,
        edits: [{ oldText: "absent\n", newText: "after\n" }],
      },
      output: JSON.stringify({
        status: "error",
        tool: "edit",
        error: `Could not find the exact text in ${editRecoveryPath}. The old text must match exactly`,
      }),
    },
    retry: {
      name: "edit",
      args: {
        path: editRecoveryPath,
        edits: [{ oldText: "before\n", newText: "after\n" }],
      },
      output: `Successfully replaced 1 block(s) in ${editRecoveryPath}.`,
    },
  };

  async function postResponses(baseUrl: string, body: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: false }),
    });
    return { response, body: await response.json() };
  }

  function outputFor(callId: string, output: string) {
    return { type: "function_call_output", call_id: callId, output };
  }

  function appendOutput(
    input: Array<Record<string, unknown>>,
    response: { body: { output?: Array<{ call_id?: unknown }> } },
    output: string,
  ) {
    const callId = response.body.output?.[0]?.call_id;
    if (typeof callId !== "string") {
      throw new Error("edit recovery response omitted call_id");
    }
    input.push(outputFor(callId, output));
  }

  function createEditRecoveryConversation(baseUrl: string, marker: string) {
    const input: Array<Record<string, unknown>> = [{ content: `Run ${marker}.`, role: "user" }];
    const request = () =>
      postResponses(baseUrl, {
        input,
        tools: editRecoveryTools,
      });
    return {
      input,
      request,
      appendOutput: (response: Awaited<ReturnType<typeof request>>, output: string) =>
        appendOutput(input, response, output),
    };
  }

  function expectToolCall(
    response: Awaited<ReturnType<ReturnType<typeof createEditRecoveryConversation>["request"]>>,
    name: string,
    args: Record<string, unknown>,
  ) {
    expect(response.body.output?.[0]).toMatchObject({
      arguments: JSON.stringify(args),
      name,
      type: "function_call",
    });
  }

  async function completeTool(
    conversation: ReturnType<typeof createEditRecoveryConversation>,
    name: string,
    args: Record<string, unknown>,
    output: string,
  ) {
    const response = await conversation.request();
    expectToolCall(response, name, args);
    conversation.appendOutput(response, output);
    return response;
  }

  async function driveEditRecovery(
    conversation: ReturnType<typeof createEditRecoveryConversation>,
    options: { retry: boolean; replaySeed?: boolean },
  ) {
    const seed = await conversation.request();
    expectToolCall(seed, editRecoveryTranscript.seed.name, editRecoveryTranscript.seed.args);
    if (options.replaySeed) {
      const replay = await conversation.request();
      expect(replay.body.output).toEqual(seed.body.output);
    }
    conversation.appendOutput(seed, editRecoveryTranscript.seed.output);
    const responses = [seed];
    const remainingSteps = options.retry
      ? [editRecoveryTranscript.failure, editRecoveryTranscript.retry]
      : [editRecoveryTranscript.failure];
    for (const step of remainingSteps) {
      responses.push(await completeTool(conversation, step.name, step.args, step.output));
    }
    const final = await conversation.request();
    expect(final.body.output?.[0]?.content?.[0]?.text).toBe(
      options.retry
        ? "OPENCLAW_E2E_EDIT_FAILURE_MATCHED_RETRY_FINAL"
        : "OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED_FINAL",
    );
    responses.push(final);
    return responses;
  }

  it("drives deterministic edit recovery sequencing and replay at the HTTP boundary", async () => {
    await withMockServer(mockOpenAiPath, {}, async (baseUrl) => {
      const unresolved = createEditRecoveryConversation(
        baseUrl,
        "OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED",
      );
      const matchedRetry = createEditRecoveryConversation(
        baseUrl,
        "OPENCLAW_E2E_EDIT_FAILURE_MATCHED_RETRY",
      );
      expect((await driveEditRecovery(unresolved, { retry: false })).length).toBe(3);
      expect(
        (await driveEditRecovery(matchedRetry, { retry: true, replaySeed: true })).length,
      ).toBe(4);
    });
  });

  it("keeps interleaved edit recovery transcripts independent", async () => {
    await withMockServer(mockOpenAiPath, {}, async (baseUrl) => {
      const unresolved = createEditRecoveryConversation(
        baseUrl,
        "OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED",
      );
      const matchedRetry = createEditRecoveryConversation(
        baseUrl,
        "OPENCLAW_E2E_EDIT_FAILURE_MATCHED_RETRY",
      );
      for (const conversation of [unresolved, matchedRetry]) {
        await completeTool(
          conversation,
          editRecoveryTranscript.seed.name,
          editRecoveryTranscript.seed.args,
          editRecoveryTranscript.seed.output,
        );
      }
      for (const conversation of [unresolved, matchedRetry]) {
        await completeTool(
          conversation,
          editRecoveryTranscript.failure.name,
          editRecoveryTranscript.failure.args,
          editRecoveryTranscript.failure.output,
        );
      }
      const unresolvedFinal = await unresolved.request();
      expect(unresolvedFinal.body.output?.[0]?.content?.[0]?.text).toBe(
        "OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED_FINAL",
      );
      await completeTool(
        matchedRetry,
        editRecoveryTranscript.retry.name,
        editRecoveryTranscript.retry.args,
        editRecoveryTranscript.retry.output,
      );
      expect((await matchedRetry.request()).body.output?.[0]?.content?.[0]?.text).toBe(
        "OPENCLAW_E2E_EDIT_FAILURE_MATCHED_RETRY_FINAL",
      );
    });
  });

  it("returns fixture errors for missing tools, malformed outcomes, and impossible prefixes", async () => {
    await withMockServer(mockOpenAiPath, {}, async (baseUrl) => {
      const missingTools = await postResponses(baseUrl, {
        input: [{ content: "Run OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED.", role: "user" }],
      });
      expect(missingTools.body.output?.[0]?.content?.[0]?.text).toContain(
        "OPENCLAW_E2E_EDIT_FAILURE_FIXTURE_ERROR",
      );

      const malformedPrefix = await postResponses(baseUrl, {
        input: [
          { content: "Run OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED.", role: "user" },
          outputFor("wrong-call-id", "not a write result"),
        ],
        tools: editRecoveryTools,
      });
      expect(malformedPrefix.body.output?.[0]?.content?.[0]?.text).toContain(
        "OPENCLAW_E2E_EDIT_FAILURE_FIXTURE_ERROR",
      );

      const conversation = createEditRecoveryConversation(
        baseUrl,
        "OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED",
      );
      const seed = await conversation.request();
      const seedCallId = seed.body.output?.[0]?.call_id;
      if (typeof seedCallId !== "string") {
        throw new Error("malformed edit recovery seed response omitted call_id");
      }
      const malformedOutcome = await postResponses(baseUrl, {
        input: [
          { content: "Run OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED.", role: "user" },
          outputFor(seedCallId, "not a write result"),
        ],
        tools: editRecoveryTools,
      });
      expect(malformedOutcome.body.output?.[0]?.content?.[0]?.text).toContain(
        "OPENCLAW_E2E_EDIT_FAILURE_FIXTURE_ERROR",
      );
    });
  });

  it("echoes dynamic OpenClaw E2E markers", async () => {
    await withMockServer(mockOpenAiPath, {}, async (baseUrl) => {
      for (const marker of ["OPENCLAW_E2E_SEED_0_123", "OPENCLAW_E2E_ANDROID_OK"]) {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: `Reply exactly with ${marker}.`,
            stream: false,
          }),
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.output?.[0]?.content?.[0]?.text).toBe(marker);
      }
    });
  });

  it("can split a deterministic response across delayed streaming deltas", async () => {
    await withMockServer(
      mockOpenAiPath,
      {
        MOCK_RESPONSE_CHUNK_DELAY_MS: "80",
        SUCCESS_MARKER: "First streamed preview remains visible before the follow-up edit arrives.",
      },
      async (baseUrl) => {
        const startedAt = Date.now();
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "return the configured marker", stream: true }),
        });
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(body.match(/response\.output_text\.delta/gu)).toHaveLength(2);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
      },
    );
  });

  it("drives the MCP App fixture tool before returning the visible marker", async () => {
    await withMockServer(mockOpenAiPath, {}, async (baseUrl) => {
      const first = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: [{ content: "mcp app conformance qa check", role: "user" }],
          stream: false,
          tools: [{ name: "fixture__show", parameters: { type: "object" }, type: "function" }],
        }),
      });
      const firstBody = await first.json();
      expect(firstBody.output?.[0]).toMatchObject({
        arguments: "{}",
        name: "fixture__show",
        type: "function_call",
      });

      const second = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: [
            { content: "mcp app conformance qa check", role: "user" },
            { output: "initial-result", type: "function_call_output" },
          ],
          stream: false,
        }),
      });
      const secondBody = await second.json();
      expect(secondBody.output?.[0]?.content?.[0]?.text).toBe("MCP_APP_CONFORMANCE_READY");
    });
  });

  it("drives the Agent Plugins bundle tool and validates its environment output", async () => {
    await withMockServer(mockOpenAiPath, {}, async (baseUrl) => {
      const missingTool = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: [{ content: "agent plugin bundle qa check", role: "user" }],
          stream: false,
        }),
      });
      const missingToolBody = await missingTool.json();
      expect(missingToolBody.output?.[0]?.content?.[0]?.text).toBe(
        "AGENT_BUNDLE_MCP_FAIL tool-not-declared",
      );

      const first = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: [{ content: "agent plugin bundle qa check", role: "user" }],
          stream: false,
          tools: [
            {
              name: "weather-probe__weather_probe",
              parameters: { type: "object" },
              type: "function",
            },
          ],
        }),
      });
      const firstBody = await first.json();
      expect(firstBody.output?.[0]).toMatchObject({
        arguments: "{}",
        name: "weather-probe__weather_probe",
        type: "function_call",
      });

      const second = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: [
            { content: "agent plugin bundle qa check", role: "user" },
            {
              output: "probe ok; PLUGIN_ROOT=/tmp/plugin; PLUGIN_DATA=/tmp/plugin-data",
              type: "function_call_output",
            },
          ],
          stream: false,
        }),
      });
      const secondBody = await second.json();
      expect(secondBody.output?.[0]?.content?.[0]?.text).toBe("AGENT_BUNDLE_MCP_OK");

      const unexpectedOutput = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: [
            { content: "agent plugin bundle qa check", role: "user" },
            { output: "probe failed", type: "function_call_output" },
          ],
          stream: false,
        }),
      });
      const unexpectedOutputBody = await unexpectedOutput.json();
      expect(unexpectedOutputBody.output?.[0]?.content?.[0]?.text).toBe(
        "AGENT_BUNDLE_MCP_FAIL unexpected-tool-output",
      );
    });
  });
});

describe("e2e mock and config helper numeric limits", () => {
  it("rejects loose mock OpenAI port env values", () => {
    const mockPort = runScript(mockOpenAiPath, { MOCK_PORT: "44080tcp" });
    expect(mockPort.status).not.toBe(0);
    expect(mockPort.stderr).toContain("invalid MOCK_PORT: 44080tcp");

    const fallbackPort = runScript(mockOpenAiPath, {
      OPENCLAW_MOCK_OPENAI_PORT: "44080http",
    });
    expect(fallbackPort.status).not.toBe(0);
    expect(fallbackPort.stderr).toContain("invalid OPENCLAW_MOCK_OPENAI_PORT: 44080http");
  });

  it("rejects out-of-range mock OpenAI port env values", () => {
    const mockPort = runScript(mockOpenAiPath, { MOCK_PORT: "65536" });
    expect(mockPort.status).not.toBe(0);
    expect(mockPort.stderr).toContain("invalid MOCK_PORT: 65536");

    const fallbackPort = runScript(mockOpenAiPath, {
      OPENCLAW_MOCK_OPENAI_PORT: "65536",
    });
    expect(fallbackPort.status).not.toBe(0);
    expect(fallbackPort.stderr).toContain("invalid OPENCLAW_MOCK_OPENAI_PORT: 65536");
  });

  it("rejects loose OpenAI web-search mock port env values", () => {
    const result = runScript(webSearchMockPath, { MOCK_PORT: "80http" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid MOCK_PORT: 80http");
  });

  it("rejects out-of-range fixture listener ports", () => {
    const webSearch = runScript(webSearchMockPath, { MOCK_PORT: "65536" });
    expect(webSearch.status).not.toBe(0);
    expect(webSearch.stderr).toContain("invalid MOCK_PORT: 65536");

    const browserFixture = runScript(browserCdpFixturePath, { FIXTURE_PORT: "65536" });
    expect(browserFixture.status).not.toBe(0);
    expect(browserFixture.stderr).toContain("invalid FIXTURE_PORT: 65536");

    const clickClack = runScript(clickClackFixturePath, {
      CLICKCLACK_FIXTURE_PORT: "65536",
    });
    expect(clickClack.status).not.toBe(0);
    expect(clickClack.stderr).toContain("invalid CLICKCLACK_FIXTURE_PORT: 65536");
  });

  it("rejects loose config-reload log timeout env values", () => {
    const result = runScript(configReloadAssertPath, {
      OPENCLAW_CONFIG_RELOAD_LOG_TIMEOUT_MS: "30000ms",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_CONFIG_RELOAD_LOG_TIMEOUT_MS: 30000ms");
  });

  it("rejects loose config-reload log read caps", () => {
    const result = runScript(configReloadAssertPath, {
      OPENCLAW_CONFIG_RELOAD_LOG_MAX_READ_BYTES: "256kb",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_CONFIG_RELOAD_LOG_MAX_READ_BYTES: 256kb");
  });

  it("returns a clear error when mock OpenAI cannot append request logs", async () => {
    const requestLogDirectory = await mkdtemp(join(tmpdir(), "openclaw-mock-request-log-"));
    try {
      await withMockServer(
        mockOpenAiPath,
        { MOCK_REQUEST_LOG: requestLogDirectory },
        async (baseUrl, output) => {
          const response = await fetch(`${baseUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: "OPENCLAW_E2E_OK" }),
          });
          const body = await response.json();

          expect(response.status).toBe(500);
          expect(body.error.message).toContain("mock OpenAI request log write failed");
          await expect
            .poll(() => output.stderr(), { timeout: 1_000 })
            .toContain("mock-openai request log write failed");
        },
      );
    } finally {
      await rm(requestLogDirectory, { force: true, recursive: true });
    }
  });

  it("returns a clear error when web-search mock cannot append request logs", async () => {
    const requestLogDirectory = await mkdtemp(join(tmpdir(), "openclaw-web-search-log-"));
    try {
      await withMockServer(
        webSearchMockPath,
        {
          MOCK_REQUEST_LOG: requestLogDirectory,
          RAW_SCHEMA_ERROR: "400 schema rejected",
          SUCCESS_MARKER: "OPENCLAW_SCHEMA_E2E_OK",
        },
        async (baseUrl, output) => {
          const response = await fetch(`${baseUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: "OPENCLAW_SCHEMA_E2E_OK",
              reasoning: { effort: "low" },
              tools: [{ type: "web_search" }],
            }),
          });
          const body = await response.json();

          expect(response.status).toBe(500);
          expect(body.error.message).toContain("mock OpenAI request log write failed");
          await expect
            .poll(() => output.stderr(), { timeout: 1_000 })
            .toContain("mock-openai-web-search request log write failed");
        },
      );
    } finally {
      await rm(requestLogDirectory, { force: true, recursive: true });
    }
  });
});
