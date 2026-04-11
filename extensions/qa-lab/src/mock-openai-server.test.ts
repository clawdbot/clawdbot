import { afterEach, describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";

const cleanups: Array<() => Promise<void>> = [];
const QA_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3RQQkAMAzAwPg33Wnos+wgBo40dboAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANYADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAC+Azy47PDiI4pA2wAAAABJRU5ErkJggg==";

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

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
});
