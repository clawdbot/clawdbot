// E2E Mock Config Limits tests cover e2e mock config limits script behavior.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { validateToolArguments } from "../../packages/llm-core/src/validation.js";
import { execSchema } from "../../src/agents/bash-tools.schemas.js";
import { writeJsonAtomic } from "../../src/infra/json-files.js";
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
  "MOCK_BIND_HOST",
  "MOCK_PORT",
  "MOCK_REQUEST_LOG",
  "MOCK_RESPONSE_CHUNK_DELAY_MS",
  "MOCK_RESPONSE_CONTROL",
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
  it.each([
    { api: "responses", stream: false },
    { api: "responses", stream: true },
    { api: "chat/completions", stream: false },
    { api: "chat/completions", stream: true },
  ])("emits native exec draft-proof calls from $api (stream=$stream)", async ({ api, stream }) => {
    await withMockServer(
      mockOpenAiPath,
      { MOCK_DRAFTPROOF_FINAL_DELAY_MS: "80" },
      async (baseUrl) => {
        const user = { role: "user", content: "return OPENCLAW_E2E_DRAFTPROOF" };
        const tool = {
          name: "exec",
          description: "Execute a shell command",
          parameters: execSchema,
        };
        const request = async (turns: unknown[]) => {
          const response = await fetch(`${baseUrl}/v1/${api}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              [api === "responses" ? "input" : "messages"]: turns,
              tools: [
                api === "responses"
                  ? { type: "function", ...tool }
                  : { type: "function", function: tool },
              ],
              stream,
            }),
          });
          expect(response.status).toBe(200);
          if (!stream) {
            return [await response.json()];
          }
          return (await response.text())
            .split("\n\n")
            .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
            .map((line) => JSON.parse(line.slice(6)));
        };

        const first = await request([user]);
        let call;
        let assistant;
        if (api === "responses") {
          const items = stream
            ? first
                .filter((event) => event.type === "response.output_item.done")
                .map((event) => event.item)
            : first[0].output;
          expect(items).toHaveLength(2);
          expect(items[0]).toMatchObject({
            type: "message",
            phase: "commentary",
            content: [{ type: "output_text", text: "Checking the workspace before answering." }],
          });
          call = items[1];
          expect(call).toMatchObject({ type: "function_call", name: "exec" });
          assistant = items;
        } else {
          const messages = first.map((chunk) =>
            stream ? chunk.choices[0].delta : chunk.choices[0].message,
          );
          const toolIndex = messages.findIndex((message) => message.tool_calls?.length);
          expect(toolIndex).toBeGreaterThanOrEqual(0);
          expect(
            messages
              .slice(0, toolIndex + 1)
              .map((message) => message.content ?? "")
              .join(""),
          ).toBe("Checking the workspace before answering.");
          expect(messages.slice(toolIndex + 1).some((message) => message.content)).toBe(false);
          const toolCalls = messages[toolIndex].tool_calls;
          expect(toolCalls).toHaveLength(1);
          call = { ...toolCalls[0].function, call_id: toolCalls[0].id };
          expect(call.name).toBe("exec");
          assistant = [
            {
              role: "assistant",
              content: "Checking the workspace before answering.",
              tool_calls: toolCalls,
            },
          ];
        }

        // A final marker also follows validation errors; prove the emitted call itself works.
        const args = JSON.parse(call.arguments);
        validateToolArguments(tool, {
          type: "toolCall",
          id: call.call_id,
          name: call.name,
          arguments: args,
        });
        expect(args.command).toBe("sleep 3 && echo openclaw-draft-proof");
        let toolOutput = "openclaw-draft-proof\n";
        // The command is POSIX shell syntax; Windows still covers HTTP and native validation.
        if (process.platform !== "win32") {
          const startedAt = performance.now();
          const result = spawnSync("bash", ["-c", args.command], {
            encoding: "utf8",
            timeout: 10_000,
          });
          expect(result.status, result.stderr).toBe(0);
          expect(result.signal).toBeNull();
          expect(result.stdout).toBe(toolOutput);
          expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_900);
          toolOutput = result.stdout;
        }

        const finalStartedAt = performance.now();
        const final = await request([
          user,
          ...assistant,
          api === "responses"
            ? { type: "function_call_output", call_id: call.call_id, output: toolOutput }
            : { role: "tool", tool_call_id: call.call_id, content: toolOutput },
        ]);
        if (api === "responses") {
          const response = stream
            ? final.find((event) => event.type === "response.completed").response
            : final[0];
          expect(response.output[0].content[0].text).toBe("OPENCLAW_E2E_DRAFTPROOF");
        } else {
          expect(
            final
              .map((chunk) =>
                stream ? (chunk.choices[0].delta.content ?? "") : chunk.choices[0].message.content,
              )
              .join(""),
          ).toBe("OPENCLAW_E2E_DRAFTPROOF");
          expect(performance.now() - finalStartedAt).toBeGreaterThanOrEqual(60);
        }
      },
    );
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

  it("accepts response-control delays above 60 seconds", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-mock-response-delay-"));
    const control = join(root, "response.json");
    try {
      await writeFile(control, JSON.stringify({ chunkDelayMs: 60_001, text: "delayed response" }));
      await withMockServer(mockOpenAiPath, { MOCK_RESPONSE_CONTROL: control }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "validate the configured delay", stream: false }),
        });

        expect(response.status).toBe(200);
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reloads the lane-owned response control between turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-mock-response-"));
    const control = join(root, "response.json");
    try {
      await writeFile(control, JSON.stringify({ chunkDelayMs: 0, text: "first response" }));
      await withMockServer(mockOpenAiPath, { MOCK_RESPONSE_CONTROL: control }, async (baseUrl) => {
        const request = () =>
          fetch(`${baseUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: "return OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED",
              stream: false,
            }),
          }).then((response) => response.json());
        expect((await request()).output?.[0]?.content?.[0]?.text).toBe("first response");
        const completion = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [{ content: "return OPENCLAW_E2E_DRAFTPROOF", role: "user" }],
            stream: false,
          }),
        }).then((response) => response.json());
        expect(completion.choices?.[0]?.message?.content).toBe("first response");
        await writeFile(control, JSON.stringify({ chunkDelayMs: 0, text: "second response" }));
        expect((await request()).output?.[0]?.content?.[0]?.text).toBe("second response");
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("streams lane-owned raw Responses API events", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-mock-response-events-"));
    const control = join(root, "response.json");
    const events = [
      { delta: "< / internal", type: "response.reasoning_text.delta" },
      { delta: "VISIBLE", type: "response.output_text.delta" },
      { response: { output: [], status: "completed" }, type: "response.completed" },
    ];
    try {
      await writeFile(control, JSON.stringify({ events }));
      await withMockServer(mockOpenAiPath, { MOCK_RESPONSE_CONTROL: control }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "exercise raw events", stream: true }),
        });
        const body = await response.text();
        expect(response.status).toBe(200);
        for (const event of events) {
          expect(body).toContain(`data: ${JSON.stringify(event)}`);
        }
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("holds a lane response until the recorder reveals the outbound message", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-mock-response-hold-"));
    const control = join(root, "response.json");
    try {
      await writeFile(
        control,
        JSON.stringify({ chunkDelayMs: 0, hold: true, text: "visible after reveal" }),
      );
      await withMockServer(mockOpenAiPath, { MOCK_RESPONSE_CONTROL: control }, async (baseUrl) => {
        let settled = false;
        const request = fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "wait until visible", stream: false }),
        }).then(async (response) => {
          settled = true;
          return await response.json();
        });
        await delay(75);
        expect(settled).toBe(false);
        // The held request polls this file; never expose a truncated control document.
        await writeJsonAtomic(control, {
          chunkDelayMs: 0,
          hold: false,
          text: "visible after reveal",
        });
        const body = await request;
        expect(body.output?.[0]?.content?.[0]?.text, JSON.stringify(body)).toBe(
          "visible after reveal",
        );
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("consumes scripted responses in order and logs the selected entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-mock-response-script-"));
    const control = join(root, "response.json");
    const requestLog = join(root, "requests.ndjson");
    const script = {
      scriptVersion: "script-1",
      hold: true,
      responses: [
        { text: "first response" },
        { fail: { status: 429, message: "OAuth token refresh failed for openai: invalid_grant" } },
        { text: "third response" },
      ],
      default: { text: "default response" },
    };
    try {
      await writeFile(control, JSON.stringify(script));
      await writeFile(requestLog, "");
      await withMockServer(
        mockOpenAiPath,
        { MOCK_REQUEST_LOG: requestLog, MOCK_RESPONSE_CONTROL: control },
        async (baseUrl) => {
          const request = () =>
            fetch(`${baseUrl}/v1/responses`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ input: "scripted turn", stream: false }),
            });
          const firstPromise = request();
          await delay(75);
          await writeJsonAtomic(control, { ...script, hold: false });
          const first = await firstPromise;
          const firstBody = await first.json();
          expect(firstBody.output?.[0]?.content?.[0]?.text, JSON.stringify(firstBody)).toBe(
            "first response",
          );
          const second = await request();
          expect(second.status).toBe(429);
          expect(await second.json()).toEqual({
            error: { message: "OAuth token refresh failed for openai: invalid_grant" },
          });
          const third = await request();
          expect((await third.json()).output?.[0]?.content?.[0]?.text).toBe("third response");
          const fourth = await request();
          expect((await fourth.json()).output?.[0]?.content?.[0]?.text).toBe("default response");
          await writeFile(
            control,
            JSON.stringify({ ...script, hold: false, scriptVersion: "script-2" }),
          );
          const reset = await request();
          expect((await reset.json()).output?.[0]?.content?.[0]?.text).toBe("first response");
          await writeFile(
            control,
            JSON.stringify({ responses: [{ text: "last response" }], scriptVersion: "script-3" }),
          );
          expect((await (await request()).json()).output?.[0]?.content?.[0]?.text).toBe(
            "last response",
          );
          expect((await (await request()).json()).output?.[0]?.content?.[0]?.text).toBe(
            "last response",
          );

          const entries = (await readFile(requestLog, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(entries.map((entry) => entry.scriptEntry)).toEqual([
            { entryIndex: 0, requestIndex: 0, source: "responses" },
            { entryIndex: 1, requestIndex: 1, source: "responses" },
            { entryIndex: 2, requestIndex: 2, source: "responses" },
            { requestIndex: 3, source: "default" },
            { entryIndex: 0, requestIndex: 0, source: "responses" },
            { entryIndex: 0, requestIndex: 0, source: "responses" },
            { entryIndex: 0, requestIndex: 1, source: "last" },
          ]);
        },
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("records bounded media facts without provider payload bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-mock-content-facts-"));
    const requestLog = join(root, "requests.ndjson");
    const pdfBytes = "private-pdf-bytes";
    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");
    try {
      await writeFile(requestLog, "");
      await withMockServer(mockOpenAiPath, { MOCK_REQUEST_LOG: requestLog }, async (baseUrl) => {
        const send = async (input: unknown) => {
          const response = await fetch(`${baseUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input, stream: false }),
          });
          expect(response.status).toBe(200);
        };
        await send([
          {
            type: "message",
            role: "user",
            content: Array.from({ length: 128 }, (_, index) => ({
              type: "input_text",
              text: `historical turn ${index}`,
            })),
          },
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_file",
                filename: "proof.pdf",
                file_data: `data:application/pdf;base64,${pdfBase64}`,
              },
              { type: "input_text", text: "Summarize the staged document." },
            ],
          },
        ]);
        await send([
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "[media attached: /tmp/session/proof.pdf (application/pdf)]\nSummarize it.",
              },
            ],
          },
        ]);

        const recorded = await readFile(requestLog, "utf8");
        const entries = recorded
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(entries[0]?.contentFacts).toHaveLength(128);
        expect(entries[0]?.contentFactsTruncated).toBe(true);
        expect(entries[0]?.contentFacts.slice(-2)).toEqual([
          {
            type: "input_file",
            filename: "proof.pdf",
            mimeType: "application/pdf",
            byteLength: Buffer.byteLength(pdfBytes),
          },
          { type: "input_text" },
        ]);
        expect(entries[1]?.contentFacts).toEqual([
          { type: "input_text" },
          {
            type: "legacy_media",
            filename: "/tmp/session/proof.pdf",
            mimeType: "application/pdf",
          },
        ]);
        expect(recorded).not.toContain(pdfBase64);
        expect(entries[0]?.body).toContain("data:application/pdf;base64,[redacted:17 bytes]");
        expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);

        // Redaction walks parsed JSON, so an unparseable body must never be
        // logged as raw text — that path would leak the base64 payload.
        const malformed = `{"input": "data:application/pdf;base64,${pdfBase64}"`;
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: malformed,
        });
        expect(response.status).toBe(200);
        const withMalformed = await readFile(requestLog, "utf8");
        expect(withMalformed).not.toContain(pdfBase64);
        const malformedEntry = withMalformed
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .at(-1);
        expect(malformedEntry?.body).toBe(
          `[unparseable request body redacted: ${Buffer.byteLength(malformed)} bytes]`,
        );
        expect(malformedEntry?.seq).toBe(3);
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("supports scripted connection drops", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-mock-response-drop-"));
    const control = join(root, "response.json");
    try {
      await writeFile(
        control,
        JSON.stringify({ responses: [{ fail: { mode: "drop" } }], scriptVersion: "drop-1" }),
      );
      await withMockServer(mockOpenAiPath, { MOCK_RESPONSE_CONTROL: control }, async (baseUrl) => {
        await expect(
          fetch(`${baseUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: "drop this turn", stream: false }),
          }),
        ).rejects.toThrow();
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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
