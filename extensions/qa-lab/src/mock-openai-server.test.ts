import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderVariant, startQaMockOpenAiServer } from "./mock-openai-server.js";

const cleanups: Array<() => Promise<void>> = [];
const QA_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3RQQkAMAzAwPg33Wnos+wgBo40dboAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANYADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAC+Azy47PDiI4pA2wAAAABJRU5ErkJggg==";
const QA_REASONING_ONLY_RECOVERY_PROMPT =
  "Reasoning-only continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly REASONING-RECOVERED-OK.";
const QA_REASONING_ONLY_SIDE_EFFECT_PROMPT =
  "Reasoning-only after write safety check: write reasoning-only-side-effect.txt, then answer with exactly SIDE-EFFECT-GUARD-OK.";
const QA_EMPTY_RESPONSE_RECOVERY_PROMPT =
  "Empty response continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-RECOVERED-OK.";
const QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT =
  "Empty response exhaustion QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-EXHAUSTED-OK.";
const QA_REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const QA_EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startMockServer() {
  const server = await startQaMockOpenAiServer({
    host: "127.0.0.1",
    port: 0,
  });
  cleanups.push(async () => {
    await server.stop();
  });
  return server;
}

async function postResponses(server: { baseUrl: string }, body: unknown) {
  return fetch(`${server.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function expectResponsesText(server: { baseUrl: string }, body: unknown) {
  const response = await postResponses(server, body);
  expect(response.status).toBe(200);
  return response.text();
}

async function expectResponsesJson<T>(server: { baseUrl: string }, body: unknown) {
  const response = await postResponses(server, body);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function makeUserInput(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "input_text" as const, text }],
  };
}

describe("qa mock openai server", () => {
  it("serves health and streamed responses", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const health = await fetch(`${server.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, status: "live" });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Inspect the repo docs and kickoff task." }],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"type":"response.output_item.added"');
    expect(body).toContain('"name":"read"');
  });

  it("emits deterministic text deltas for generic streaming QA prompts", async () => {
    const server = await startMockServer();

    const quietResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput("Quiet streaming QA check: reply exactly `MATRIX_QA_STREAMING_OK`.")],
      }),
    });
    expect(quietResponse.status).toBe(200);
    const quietBody = await quietResponse.text();
    expect(quietBody).toContain('"type":"response.output_text.delta"');
    expect(quietBody).toContain('"phase":"final_answer"');
    expect(quietBody).toContain("MATRIX_QA_STREAMING_OK");

    const blockResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          makeUserInput(
            "Block streaming QA check: emit exactly two assistant message blocks in order. First exact marker: `BLOCK_ONE_OK`. Second exact marker: `BLOCK_TWO_OK`.",
          ),
        ],
      }),
    });
    expect(blockResponse.status).toBe(200);
    const blockBody = await blockResponse.text();
    expect(blockBody).toContain('"item_id":"msg_mock_block_1"');
    expect(blockBody).toContain('"item_id":"msg_mock_block_2"');
    expect(blockBody).toContain("BLOCK_ONE_OK");
    expect(blockBody).toContain("BLOCK_TWO_OK");
  });

  it("prefers path-like refs over generic quoted keys in prompts", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: 'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"arguments":"{\\"path\\":\\"QA_KICKOFF_TASK.md\\"}"');

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    expect(await debugResponse.json()).toMatchObject({
      prompt: 'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
      allInputText: 'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
      plannedToolName: "read",
    });
  });

  it("drives the Lobster Invaders write flow and memory recall responses", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const lobster = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.4",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Please build Lobster Invaders after reading context." },
            ],
          },
          {
            type: "function_call_output",
            output: "QA mission: read source and docs first.",
          },
        ],
      }),
    });
    expect(lobster.status).toBe(200);
    const lobsterBody = await lobster.text();
    expect(lobsterBody).toContain('"name":"write"');
    expect(lobsterBody).toContain("lobster-invaders.html");

    const recall = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.4-alt",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "What was the QA canary code I asked you to remember earlier?",
              },
            ],
          },
        ],
      }),
    });
    expect(recall.status).toBe(200);
    const payload = (await recall.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("ALPHA-7");

    const requests = await fetch(`${server.baseUrl}/debug/requests`);
    expect(requests.status).toBe(200);
    expect((await requests.json()) as Array<{ model?: string }>).toMatchObject([
      { model: "gpt-5.4" },
      { model: "gpt-5.4-alt" },
    ]);
  });

  it("keeps remember prompts prose-only even when they mention repo cleanup", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.4",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Remembered ALPHA-7.");
    expect(body).not.toContain('"name":"read"');
  });

  it("drives repo-contract followthrough as read-read-read-write-then-report", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const first = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"arguments":"{\\"path\\":\\"AGENT.md\\"}"');

    const second = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.4",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
          },
        ],
      }),
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('"arguments":"{\\"path\\":\\"SOUL.md\\"}"');

    const third = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.4",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output: "# Execution style\n\nStay brief, honest, and action-first.\n",
          },
        ],
      }),
    });
    expect(third.status).toBe(200);
    expect(await third.text()).toContain('"arguments":"{\\"path\\":\\"FOLLOWTHROUGH_INPUT.md\\"}"');

    const fourth = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.4",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "Mission: prove you followed the repo contract.\nEvidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md -> repo-contract-summary.txt\n",
          },
        ],
      }),
    });
    expect(fourth.status).toBe(200);
    const fourthBody = await fourth.text();
    expect(fourthBody).toContain('"name":"write"');
    expect(fourthBody).toContain("repo-contract-summary.txt");

    const fifth = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.4",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "Successfully wrote repo-contract-summary.txt\nMission: prove you followed the repo contract.\nStatus: complete\n",
          },
        ],
      }),
    });
    expect(fifth.status).toBe(200);
    const payload = (await fifth.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("Read: AGENT.md, SOUL.md");
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("Wrote: repo-contract-summary.txt");
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("Status: complete");
  });

  it("drives the compaction retry mutating tool parity flow", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const writePlan = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.4",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: "compaction retry evidence block 0000\ncompaction retry evidence block 0001",
          },
        ],
      }),
    });
    expect(writePlan.status).toBe(200);
    const writePlanBody = await writePlan.text();
    expect(writePlanBody).toContain('"name":"write"');
    expect(writePlanBody).toContain("compaction-retry-summary.txt");

    const finalReply = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.4",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: "Successfully wrote 41 bytes to compaction-retry-summary.txt.",
          },
        ],
      }),
    });
    expect(finalReply.status).toBe(200);
    const finalPayload = (await finalReply.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(finalPayload.output?.[0]?.content?.[0]?.text).toContain("replay unsafe after write");
  });

  it("supports exact reply memory prompts and embeddings requests", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const remember = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7. Reply exactly `Remembered ALPHA-7.` once stored.",
              },
            ],
          },
        ],
      }),
    });
    expect(remember.status).toBe(200);
    const rememberPayload = (await remember.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(rememberPayload.output?.[0]?.content?.[0]?.text).toBe("Remembered ALPHA-7.");

    const embeddings = await fetch(`${server.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: ["Project Nebula ORBIT-10", "Project Nebula ORBIT-9"],
      }),
    });
    expect(embeddings.status).toBe(200);
    const embeddingPayload = (await embeddings.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      model?: string;
    };
    expect(embeddingPayload.model).toBe("text-embedding-3-small");
    expect(embeddingPayload.data).toHaveLength(2);
    expect(embeddingPayload.data?.[0]?.index).toBe(0);
    expect(embeddingPayload.data?.[0]?.embedding?.length).toBeGreaterThan(0);
  });

  it("requests non-threaded subagent handoff for QA channel runs", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Delegate a bounded QA task to a subagent, then summarize the delegated result clearly.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"sessions_spawn"');
    expect(body).toContain('\\"label\\":\\"qa-sidecar\\"');
    expect(body).toContain('\\"thread\\":false');
  });

  it("plans memory tools and serves mock image generations", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const memorySearch = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.",
              },
            ],
          },
        ],
      }),
    });
    expect(memorySearch.status).toBe(200);
    expect(await memorySearch.text()).toContain('"name":"memory_search"');

    const image = await fetch(`${server.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: "Draw a QA lighthouse",
        n: 1,
        size: "1024x1024",
      }),
    });
    expect(image.status).toBe(200);
    expect(await image.json()).toMatchObject({
      data: [{ b64_json: expect.any(String) }],
    });

    const imageRequests = await fetch(`${server.baseUrl}/debug/image-generations`);
    expect(imageRequests.status).toBe(200);
    expect(await imageRequests.json()).toMatchObject([
      {
        model: "gpt-image-1",
        prompt: "Draw a QA lighthouse",
        n: 1,
        size: "1024x1024",
      },
    ]);
  });

  it("supports advanced QA memory and subagent recovery prompts", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const memory = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.",
              },
            ],
          },
        ],
      }),
    });
    expect(memory.status).toBe(200);
    expect(await memory.text()).toContain('"name":"memory_search"');

    const memoryFollowup = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: JSON.stringify({
              results: [
                {
                  path: "sessions/qa-session-memory-ranking.jsonl",
                  startLine: 2,
                  endLine: 3,
                },
              ],
            }),
          },
        ],
      }),
    });
    expect(memoryFollowup.status).toBe(200);
    expect(await memoryFollowup.text()).toContain(
      "Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10.",
    );

    const activeMemorySearch = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "You are a memory search agent.",
                  "Use only memory_search and memory_get.",
                  "",
                  "Conversation context:",
                  "Latest user message:",
                  "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
                ].join("\n"),
              },
            ],
          },
        ],
      }),
    });
    expect(activeMemorySearch.status).toBe(200);
    expect(await activeMemorySearch.text()).toContain('"name":"memory_search"');

    const activeMemoryGet = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "You are a memory search agent.",
                  "Use only memory_search and memory_get.",
                  "",
                  "Conversation context:",
                  "Latest user message:",
                  "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
                ].join("\n"),
              },
            ],
          },
          {
            type: "function_call_output",
            output: JSON.stringify({
              results: [
                {
                  path: "MEMORY.md",
                  startLine: 1,
                  endLine: 1,
                },
              ],
            }),
          },
        ],
      }),
    });
    expect(activeMemoryGet.status).toBe(200);
    expect(await activeMemoryGet.text()).toContain('"name":"memory_get"');

    const activeMemorySummary = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "You are a memory search agent.",
                  "Use only memory_search and memory_get.",
                  "",
                  "Conversation context:",
                  "Latest user message:",
                  "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
                ].join("\n"),
              },
            ],
          },
          {
            type: "function_call_output",
            output: JSON.stringify({
              text: "Stable QA movie night snack preference: lemon pepper wings with blue cheese.",
            }),
          },
        ],
      }),
    });
    expect(activeMemorySummary.status).toBe(200);
    expect(JSON.stringify(await activeMemorySummary.json())).toContain(
      "lemon pepper wings with blue cheese",
    );

    const injectedMainReply = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        instructions: [
          "System context:",
          "<active_memory_plugin>User usually wants lemon pepper wings with blue cheese for QA movie night.</active_memory_plugin>",
        ].join("\n"),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
              },
            ],
          },
        ],
      }),
    });
    expect(injectedMainReply.status).toBe(200);
    expect(JSON.stringify(await injectedMainReply.json())).toContain(
      "lemon pepper wings with blue cheese",
    );
    const lastRequest = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(lastRequest.status).toBe(200);
    expect(await lastRequest.json()).toMatchObject({
      instructions: expect.stringContaining("<active_memory_plugin>"),
      allInputText: expect.stringContaining("<active_memory_plugin>"),
    });

    const spawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.",
              },
            ],
          },
        ],
      }),
    });
    expect(spawn.status).toBe(200);
    const spawnBody = await spawn.text();
    expect(spawnBody).toContain('"name":"sessions_spawn"');
    expect(spawnBody).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.",
              },
            ],
          },
          {
            type: "function_call_output",
            output:
              '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
          },
        ],
      }),
    });
    expect(secondSpawn.status).toBe(200);
    const secondSpawnBody = await secondSpawn.text();
    expect(secondSpawnBody).toContain('"name":"sessions_spawn"');
    expect(secondSpawnBody).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const final = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.",
              },
            ],
          },
          {
            type: "function_call_output",
            output:
              '{"status":"accepted","childSessionKey":"agent:qa:subagent:beta","note":"BETA-OK"}',
          },
        ],
      }),
    });
    expect(final.status).toBe(200);
    expect(await final.json()).toMatchObject({
      output: [
        {
          content: [
            {
              text: "Protocol note: delegated fanout complete. Alpha=ALPHA-OK. Beta=BETA-OK.",
            },
          ],
        },
      ],
    });
  });

  it("keeps subagent fanout state isolated per mock server instance", async () => {
    const serverA = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await serverA.stop();
    });
    const serverB = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await serverB.stop();
    });

    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";

    const firstA = await fetch(`${serverA.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(firstA.status).toBe(200);
    expect(await firstA.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const firstB = await fetch(`${serverB.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(firstB.status).toBe(200);
    expect(await firstB.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');
  });

  it("answers heartbeat prompts without spawning extra subagents", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "System: Gateway restart config-apply ok\nSystem: QA-SUBAGENT-RECOVERY-1234\n\nRead HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      output: [
        {
          content: [{ text: "HEARTBEAT_OK" }],
        },
      ],
    });
  });

  it("returns exact markers for visible and hot-installed skills", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const visible = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Visible skill marker: give me the visible skill marker exactly.",
              },
            ],
          },
        ],
      }),
    });
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      output: [
        {
          content: [{ text: "VISIBLE-SKILL-OK" }],
        },
      ],
    });

    const hot = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Hot install marker: give me the hot install marker exactly.",
              },
            ],
          },
        ],
      }),
    });
    expect(hot.status).toBe(200);
    expect(await hot.json()).toMatchObject({
      output: [
        {
          content: [{ text: "HOT-INSTALL-OK" }],
        },
      ],
    });
  });

  it("uses the latest exact marker directive from conversation history", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Earlier turn: reply with only this exact marker: OLD_TOKEN",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Current turn: reply with only this exact marker: NEW_TOKEN",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      output: [
        {
          content: [{ text: "NEW_TOKEN" }],
        },
      ],
    });
  });

  it("records image inputs and describes attached images", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.4",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Image understanding check: what do you see?" },
              {
                type: "input_image",
                source: {
                  type: "base64",
                  mime_type: "image/png",
                  data: QA_IMAGE_PNG_BASE64,
                },
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text = payload.output?.[0]?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");

    const debug = await fetch(`${server.baseUrl}/debug/requests`);
    expect(debug.status).toBe(200);
    expect(await debug.json()).toMatchObject([
      expect.objectContaining({
        imageInputCount: 1,
      }),
    ]);
  });

  it("describes reattached generated images in the roundtrip flow", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.4",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Roundtrip image inspection check: describe the generated lighthouse attachment in one short sentence.",
              },
              {
                type: "input_image",
                source: {
                  type: "base64",
                  mime_type: "image/png",
                  data: QA_IMAGE_PNG_BASE64,
                },
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text = payload.output?.[0]?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("lighthouse");
  });

  it("ignores stale tool output from prior turns when planning the current turn", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Read QA_KICKOFF_TASK.md first." }],
          },
          {
            type: "function_call_output",
            output: "QA mission: read source and docs first.",
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"name":"read"');
  });

  it("returns continuity language after the model-switch reread completes", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.4-alt",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      output: [
        {
          content: [
            {
              text: expect.stringContaining("model switch handoff confirmed"),
            },
          ],
        },
      ],
    });
  });

  it("returns NO_REPLY for unmentioned group chatter", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: 'Conversation info (untrusted metadata): {"is_group_chat": true}\n\nhello team, no bot ping here',
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      output: [
        {
          content: [{ text: "NO_REPLY" }],
        },
      ],
    });
  });

  it("advertises Anthropic claude-opus-4-6 baseline model on /v1/models", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((entry) => entry.id);
    expect(ids).toContain("claude-opus-4-6");
    expect(ids).toContain("gpt-5.4");
  });

  it("dispatches an Anthropic /v1/messages read tool call for source discovery prompts", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read the seeded docs and report worked, failed, blocked, and follow-up items.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      type: string;
      role: string;
      model: string;
      stop_reason: string;
      content: Array<Record<string, unknown>>;
    };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.stop_reason).toBe("tool_use");
    const toolUseBlock = body.content.find((block) => block.type === "tool_use") as
      | { name: string; input: Record<string, unknown> }
      | undefined;
    expect(toolUseBlock?.name).toBe("read");
    expect(toolUseBlock?.input).toEqual({ path: "QA_SCENARIO_PLAN.md" });

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    expect(await debugResponse.json()).toMatchObject({
      model: "claude-opus-4-6",
      plannedToolName: "read",
    });
  });

  it("dispatches Anthropic /v1/messages tool_result follow-ups through the shared scenario logic", async () => {
    // This verifies the Anthropic adapter correctly feeds tool_result
    // content blocks into the shared scenario dispatcher so downstream
    // "has this scenario already called a tool?" logic fires the same way
    // it does on the OpenAI /v1/responses route. The subagent handoff
    // scenario is ideal because the mock has a two-stage flow: first
    // delegate prompt → sessions_spawn tool_use, then tool_result →
    // "Delegated task: ..." prose summary.
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Delegate one bounded QA task to a subagent, wait for it to finish, then reply with Delegated task, Result, and Evidence sections.",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_mock_spawn_1",
                name: "sessions_spawn",
                input: { task: "Inspect the QA workspace", label: "qa-sidecar", thread: false },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_mock_spawn_1",
                content: "SUBAGENT-OK",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stop_reason: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(body.stop_reason).toBe("end_turn");
    const textBlock = body.content.find((block) => block.type === "text") as
      | { text: string }
      | undefined;
    // The mock's subagent-handoff branch echoes "Delegated task", a
    // tool-output evidence line, and a folded-back "Evidence" marker.
    expect(textBlock?.text).toContain("Delegated task");
    expect(textBlock?.text).toContain("Evidence");
  });

  it("places tool_result after the parent user message even in mixed-content turns", async () => {
    // Regression for the loop-6 Copilot / Greptile finding: a user message
    // that mixes a tool_result block with fresh text blocks must still land
    // the function_call_output AFTER the parent user message in the
    // converted ResponsesInputItem[], otherwise extractToolOutput (which
    // scans AFTER the last user-role index) fails to see the tool output
    // and the downstream scenario dispatcher behaves as if no tool output
    // was returned. We verify the conversion directly via the snapshot
    // that /debug/last-request exposes: the last-request `toolOutput`
    // field should be the stringified tool_result content, and `prompt`
    // should be the trailing fresh-text block.
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Delegate one bounded QA task to a subagent.",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_mock_spawn_mixed",
                name: "sessions_spawn",
                input: { task: "Inspect the QA workspace", label: "qa-sidecar", thread: false },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_mock_spawn_mixed",
                content: "SUBAGENT-OK",
              },
              // A trailing fresh text block in the same user turn. Before
              // the loop-6 fix, the tool_result was pushed BEFORE the
              // parent user message, so extractToolOutput saw the text
              // turn as the last user-role item and found no
              // function_call_output after it → returned "". The
              // downstream dispatcher then behaved as if no tool output
              // was present at all.
              {
                type: "text",
                text: "Keep going with the fanout.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debug = (await debugResponse.json()) as {
      prompt: string;
      allInputText: string;
      toolOutput: string;
    };
    // extractToolOutput should surface the tool_result content because
    // the function_call_output item is placed AFTER the parent user
    // message in the converted input array.
    expect(debug.toolOutput).toBe("SUBAGENT-OK");
    // extractLastUserText should surface the fresh-text block (the parent
    // user message that was pushed BEFORE the function_call_output).
    expect(debug.prompt).toBe("Keep going with the fanout.");
    // The converted history still records both turns, including the
    // original delegate prompt from the first user turn.
    expect(debug.allInputText).toContain("Delegate one bounded QA task");
  });

  it("streams Anthropic /v1/messages tool_use responses as SSE", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 256,
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read the seeded docs and report worked, failed, blocked, and follow-up items.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_start");
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"name":"read"');
    expect(body).toContain("QA_SCENARIO_PLAN.md");
    expect(body).toContain("event: message_delta");
    expect(body).toContain("event: message_stop");
  });

  it("streams Anthropic /v1/messages tool_result follow-ups as text deltas", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 256,
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Delegate one bounded QA task to a subagent, wait for it to finish, then reply with Delegated task, Result, and Evidence sections.",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_mock_spawn_1",
                name: "sessions_spawn",
                input: { task: "Inspect the QA workspace", label: "qa-sidecar", thread: false },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_mock_spawn_1",
                content: "SUBAGENT-OK",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain('"type":"text_delta"');
    expect(body).toContain("Delegated task");
    expect(body).toContain("Evidence");
  });

  it("keeps Anthropic remember prompts on the prose branch even when system text mentions HEARTBEAT", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 256,
        stream: true,
        system: [
          {
            type: "text",
            text: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.",
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored.",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Remembered ALPHA-7.");
    expect(body).not.toContain("HEARTBEAT_OK");
    expect(body).not.toContain('"name":"read"');
  });

  it("prefers the prompt-local exact reply directive over heartbeat context", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 256,
        stream: true,
        system: [
          {
            type: "text",
            text: [
              "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
              "If the current user message is a heartbeat poll and nothing needs attention, reply exactly:",
              "HEARTBEAT_OK",
            ].join("\n"),
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored.",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Remembered ALPHA-7.");
    expect(body).not.toContain("HEARTBEAT_OK");
  });

  it("rejects malformed Anthropic /v1/messages JSON with an invalid_request_error", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"claude-opus-4-6","messages":[',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("Malformed JSON body");
  });

  it("defaults empty-string Anthropic /v1/messages model to claude-opus-4-6", async () => {
    // Regression for the loop-7 Copilot finding: a bare `typeof
    // body.model === "string"` check lets an empty-string model leak
    // through to `lastRequest.model` and `responseBody.model`. Empty
    // strings must be treated the same as absent and default to
    // `"claude-opus-4-6"` so parity consumers can trust the echoed label.
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: "Read the plan",
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { model: string };
    expect(body.model).toBe("claude-opus-4-6");

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debug = (await debugResponse.json()) as { model: string };
    expect(debug.model).toBe("claude-opus-4-6");
  });

  it("scripts a reasoning-only recovery sequence after a replay-safe read", async () => {
    const server = await startMockServer();

    const toolPlan = await expectResponsesText(server, {
      stream: true,
      model: "gpt-5.4",
      input: [makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"read"');
    expect(toolPlan).toContain("QA_KICKOFF_TASK.md");

    expect(
      await expectResponsesJson<{
        output?: Array<{ type?: string; id?: string; summary?: Array<{ text?: string }> }>;
      }>(server, {
        stream: false,
        model: "gpt-5.4",
        input: [
          makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT),
          {
            type: "function_call_output",
            output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
          },
        ],
      }),
    ).toMatchObject({
      output: [
        {
          type: "reasoning",
          id: "rs_mock_reasoning_recovery",
          summary: [{ text: expect.stringContaining("Need visible answer") }],
        },
      ],
    });

    expect(
      await expectResponsesJson<{
        output?: Array<{ content?: Array<{ text?: string }> }>;
      }>(server, {
        stream: false,
        model: "gpt-5.4",
        input: [
          makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT),
          makeUserInput(QA_REASONING_ONLY_RETRY_INSTRUCTION),
          {
            type: "function_call_output",
            output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
          },
        ],
      }),
    ).toMatchObject({
      output: [
        {
          content: [{ text: "REASONING-RECOVERED-OK" }],
        },
      ],
    });

    const requests = await fetch(`${server.baseUrl}/debug/requests`);
    expect(requests.status).toBe(200);
    expect(await requests.json()).toMatchObject([
      { plannedToolName: "read" },
      { allInputText: expect.stringContaining(QA_REASONING_ONLY_RECOVERY_PROMPT) },
      { allInputText: expect.stringContaining(QA_REASONING_ONLY_RETRY_INSTRUCTION) },
    ]);
  });

  it("keeps the reasoning-only side-effect path ready for no-auto-retry QA coverage", async () => {
    const server = await startMockServer();

    const toolPlan = await expectResponsesText(server, {
      stream: true,
      model: "gpt-5.4",
      input: [makeUserInput(QA_REASONING_ONLY_SIDE_EFFECT_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"write"');
    expect(toolPlan).toContain("reasoning-only-side-effect.txt");

    expect(
      await expectResponsesJson<{
        output?: Array<{ type?: string; id?: string }>;
      }>(server, {
        stream: false,
        model: "gpt-5.4",
        input: [
          makeUserInput(QA_REASONING_ONLY_SIDE_EFFECT_PROMPT),
          {
            type: "function_call_output",
            output: "Successfully wrote 28 bytes to reasoning-only-side-effect.txt.",
          },
        ],
      }),
    ).toMatchObject({
      output: [{ type: "reasoning", id: "rs_mock_reasoning_side_effect" }],
    });

    const requests = await fetch(`${server.baseUrl}/debug/requests`);
    expect(requests.status).toBe(200);
    expect((await requests.json()) as Array<{ allInputText?: string }>).toHaveLength(2);
  });

  it("scripts an empty-response recovery sequence after a replay-safe read", async () => {
    const server = await startMockServer();

    const toolPlan = await expectResponsesText(server, {
      stream: true,
      model: "gpt-5.4",
      input: [makeUserInput(QA_EMPTY_RESPONSE_RECOVERY_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"read"');

    expect(
      await expectResponsesJson<{
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      }>(server, {
        stream: false,
        model: "gpt-5.4",
        input: [
          makeUserInput(QA_EMPTY_RESPONSE_RECOVERY_PROMPT),
          {
            type: "function_call_output",
            output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
          },
        ],
      }),
    ).toMatchObject({
      output: [
        {
          content: [{ type: "output_text", text: "" }],
        },
      ],
    });

    expect(
      await expectResponsesJson<{
        output?: Array<{ content?: Array<{ text?: string }> }>;
      }>(server, {
        stream: false,
        model: "gpt-5.4",
        input: [
          makeUserInput(QA_EMPTY_RESPONSE_RECOVERY_PROMPT),
          makeUserInput(QA_EMPTY_RESPONSE_RETRY_INSTRUCTION),
          {
            type: "function_call_output",
            output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
          },
        ],
      }),
    ).toMatchObject({
      output: [
        {
          content: [{ text: "EMPTY-RECOVERED-OK" }],
        },
      ],
    });
  });

  it("can keep emitting empty GPT turns when the single retry budget should exhaust", async () => {
    const server = await startMockServer();

    await expectResponsesText(server, {
      stream: true,
      model: "gpt-5.4",
      input: [makeUserInput(QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT)],
    });

    const firstEmpty = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.4",
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT),
        {
          type: "function_call_output",
          output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        },
      ],
    });
    expect(firstEmpty.output?.[0]?.content?.[0]?.text).toBe("");

    const secondEmpty = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.4",
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT),
        makeUserInput(QA_EMPTY_RESPONSE_RETRY_INSTRUCTION),
        {
          type: "function_call_output",
          output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        },
      ],
    });
    expect(secondEmpty.output?.[0]?.content?.[0]?.text).toBe("");
  });
});

describe("resolveProviderVariant", () => {
  it("tags prefix-qualified openai models", () => {
    expect(resolveProviderVariant("openai/gpt-5.4")).toBe("openai");
    expect(resolveProviderVariant("openai:gpt-5.4")).toBe("openai");
    expect(resolveProviderVariant("openai-codex/gpt-5.4")).toBe("openai");
  });

  it("tags prefix-qualified anthropic models", () => {
    expect(resolveProviderVariant("anthropic/claude-opus-4-6")).toBe("anthropic");
    expect(resolveProviderVariant("anthropic:claude-opus-4-6")).toBe("anthropic");
    expect(resolveProviderVariant("claude-cli/claude-opus-4-6")).toBe("anthropic");
  });

  it("tags bare model names by prefix", () => {
    expect(resolveProviderVariant("gpt-5.4")).toBe("openai");
    expect(resolveProviderVariant("gpt-5.4-alt")).toBe("openai");
    expect(resolveProviderVariant("gpt-4.5")).toBe("openai");
    expect(resolveProviderVariant("o1-preview")).toBe("openai");
    expect(resolveProviderVariant("claude-opus-4-6")).toBe("anthropic");
    expect(resolveProviderVariant("claude-sonnet-4-6")).toBe("anthropic");
  });

  it("handles case drift and whitespace", () => {
    expect(resolveProviderVariant("  OpenAI/GPT-5.4  ")).toBe("openai");
    expect(resolveProviderVariant("ANTHROPIC/CLAUDE-OPUS-4-6")).toBe("anthropic");
  });

  it("falls through to unknown for unrecognized providers", () => {
    expect(resolveProviderVariant("")).toBe("unknown");
    expect(resolveProviderVariant(undefined)).toBe("unknown");
    expect(resolveProviderVariant("mistral/mistral-large")).toBe("unknown");
    expect(resolveProviderVariant("some-random-model")).toBe("unknown");
  });
});

describe("qa mock openai server provider variant tagging", () => {
  it("records providerVariant on /debug/last-request for openai requests", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5.4",
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "Heartbeat check" }] }],
      }),
    });

    const debug = (await (await fetch(`${server.baseUrl}/debug/last-request`)).json()) as {
      model: string;
      providerVariant: string;
    };
    expect(debug.model).toBe("openai/gpt-5.4");
    expect(debug.providerVariant).toBe("openai");
  });

  it("records providerVariant=anthropic on /v1/messages requests", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 256,
        messages: [{ role: "user", content: "Heartbeat check" }],
      }),
    });

    const debug = (await (await fetch(`${server.baseUrl}/debug/last-request`)).json()) as {
      model: string;
      providerVariant: string;
    };
    expect(debug.model).toBe("claude-opus-4-6");
    expect(debug.providerVariant).toBe("anthropic");
  });

  it("records providerVariant=unknown for unrecognized models", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mistral/mistral-large",
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "Heartbeat check" }] }],
      }),
    });

    const debug = (await (await fetch(`${server.baseUrl}/debug/last-request`)).json()) as {
      providerVariant: string;
    };
    expect(debug.providerVariant).toBe("unknown");
  });
});
