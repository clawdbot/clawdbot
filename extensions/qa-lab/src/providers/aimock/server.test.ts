// Qa Lab tests cover server plugin behavior.
import { describe, expect, it } from "vitest";
import { startQaAimockServer } from "./server.js";

function makeResponsesInput(text: string) {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text,
      },
    ],
  };
}

describe("qa aimock server", () => {
  it("keeps complete large input when the upstream body is still retained", async () => {
    const server = await startQaAimockServer();
    const prompt = "u".repeat(40_000);
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "aimock/gpt-5.6-luna",
          stream: false,
          input: [makeResponsesInput(prompt)],
        }),
      });
      expect(response.status).toBe(200);
      await response.json();
      const debug = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(debug.status).toBe(200);
      const snapshot = await debug.json();
      expect(snapshot).toMatchObject({ prompt, allInputText: prompt });
      expect(snapshot.body).not.toHaveProperty("__aimock_truncated");
    } finally {
      await server.stop();
    }
  });

  it.each(["chat", "responses"])(
    "retains exact %s request facts when tool schemas exceed the upstream journal cap",
    async (dialect) => {
      const server = await startQaAimockServer();
      const model = "aimock/gpt-5.6-luna";
      const prompt = "current user marker";
      const tool = { name: "echo", description: "schema".repeat(14_000), parameters: {} };
      try {
        const response = await fetch(
          `${server.baseUrl}/v1/${dialect === "chat" ? "chat/completions" : "responses"}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model,
              stream: false,
              ...(dialect === "chat"
                ? {
                    messages: [
                      { role: "user", content: prompt },
                      { role: "tool", content: "observed tool output", tool_call_id: "call-qa" },
                    ],
                    tools: [{ type: "function", function: tool }],
                  }
                : {
                    input: [
                      makeResponsesInput(prompt),
                      {
                        type: "function_call_output",
                        output: "observed tool output",
                        call_id: "call-qa",
                      },
                    ],
                    tools: [{ type: "function", ...tool }],
                  }),
            }),
          },
        );
        expect(response.status).toBe(200);
        await response.json();
        const debug = await fetch(`${server.baseUrl}/debug/last-request`);
        expect(debug.status).toBe(200);
        const snapshot = await debug.json();
        expect(snapshot).toMatchObject({
          model,
          prompt,
          allInputText: `${prompt}\nobserved tool output`,
          toolOutput: "observed tool output",
          toolOutputCallId: "call-qa",
          providerVariant: "openai",
          body: { __aimock_truncated: true },
        });
        expect(JSON.parse(snapshot.raw)).toEqual(snapshot.body);
        expect(snapshot.body.originalByteSize).toBeGreaterThan(64 * 1024);
      } finally {
        await server.stop();
      }
    },
  );

  it.each([
    { role: "system", content: "s".repeat(70_000), omittedFields: ["allInputText"] },
    { role: "user", content: "😀".repeat(20_000), omittedFields: ["prompt", "allInputText"] },
  ])("reports incomplete $role text without poisoning later queries or metadata", async (input) => {
    const server = await startQaAimockServer();
    const post = async (messages: Array<{ role: string; content: string }>) => {
      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "aimock/gpt-5.6-luna", stream: false, messages }),
      });
      expect(response.status).toBe(200);
      await response.json();
    };
    try {
      await post([
        ...(input.role === "system" ? [{ role: "user", content: "exact current user" }] : []),
        { role: input.role, content: input.content },
      ]);
      for (const endpoint of ["last-request", "requests", "requests?after=0"]) {
        const debug = await fetch(`${server.baseUrl}/debug/${endpoint}`);
        expect(debug.status).toBe(413);
        const incomplete = await debug.json();
        expect(incomplete).toMatchObject({
          code: "QA_DEBUG_SNAPSHOT_INCOMPLETE",
          maxBytes: 64 * 1024,
          requests: [{ cursor: 1, omittedFields: input.omittedFields }],
        });
        expect(incomplete.error).toContain("/debug/request-cursor");
        expect(incomplete.requests[0].facts.model).toBe("aimock/gpt-5.6-luna");
        for (const field of input.omittedFields) {
          expect(incomplete.requests[0].facts).not.toHaveProperty(field);
        }
        if (input.role === "system") {
          expect(incomplete.requests[0].facts.prompt).toBe("exact current user");
        }
        expect(Buffer.byteLength(JSON.stringify(incomplete.requests[0]))).toBeLessThan(64 * 1024);
      }
      expect(await fetch(`${server.baseUrl}/debug/request-cursor`).then((r) => r.json())).toEqual({
        cursor: 1,
      });
      const images = await fetch(`${server.baseUrl}/debug/image-generations`);
      expect(images.status).toBe(200);
      expect(await images.json()).toEqual([]);
      expect((await fetch(`${server.baseUrl}/debug/requests?after=1.5`)).status).toBe(400);
      expect((await fetch(`${server.baseUrl}/debug/requests?after=2`)).status).toBe(409);

      await post([{ role: "user", content: "later complete request" }]);
      const latest = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(latest.status).toBe(200);
      expect(await latest.json()).toMatchObject({ prompt: "later complete request" });
      const after = await fetch(`${server.baseUrl}/debug/requests?after=1`);
      expect(after.status).toBe(200);
      expect(await after.json()).toMatchObject([{ prompt: "later complete request" }]);
      expect((await fetch(`${server.baseUrl}/debug/requests`)).status).toBe(413);

      const reset = await fetch(`${server.baseUrl}/__aimock/reset/journal`, { method: "POST" });
      expect(reset.status).toBe(200);
      expect(await fetch(`${server.baseUrl}/debug/requests`).then((r) => r.json())).toEqual([]);
      expect(await fetch(`${server.baseUrl}/debug/request-cursor`).then((r) => r.json())).toEqual({
        cursor: 2,
      });
      await post([{ role: "user", content: "after reset" }]);
      expect(
        await fetch(`${server.baseUrl}/debug/requests?after=2`).then((r) => r.json()),
      ).toMatchObject([{ prompt: "after reset" }]);
      expect((await fetch(`${server.baseUrl}/__aimock/reset`, { method: "POST" })).status).toBe(
        200,
      );
      expect(await fetch(`${server.baseUrl}/debug/requests`).then((r) => r.json())).toEqual([]);
      expect(await fetch(`${server.baseUrl}/debug/request-cursor`).then((r) => r.json())).toEqual({
        cursor: 3,
      });
    } finally {
      await server.stop();
    }
  });

  it("preserves image evidence and tool-call pairing across capped journal bodies", async () => {
    const server = await startQaAimockServer();
    const prompt = "inspect and use echo";
    const user = {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: "data:image/png;base64,cWE=" } },
      ],
    };
    const post = async (messages: unknown[]) => {
      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "aimock/gpt-5.6-luna",
          stream: false,
          messages,
          tools: [
            {
              type: "function",
              function: { name: "echo", description: "t".repeat(70_000), parameters: {} },
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      expect(
        (await fetch(`${server.baseUrl}/__aimock/fixtures`, { method: "DELETE" })).status,
      ).toBe(200);
      const configured = await fetch(`${server.baseUrl}/__aimock/fixtures`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixtures: [
            {
              match: { sequenceIndex: 0 },
              response: { toolCalls: [{ name: "echo", arguments: "{}" }] },
            },
            { match: { sequenceIndex: 1 }, response: { content: "tool observed" } },
          ],
        }),
      });
      expect(configured.status).toBe(200);
      const planned = await post([user]);
      const assistant = planned.choices[0].message;
      const toolCallId = assistant.tool_calls[0].id;
      await post([
        user,
        assistant,
        {
          role: "tool",
          content: "independent tool evidence",
          tool_call_id: toolCallId,
          isError: true,
        },
        {
          role: "user",
          content:
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      ]);
      const requests = await fetch(`${server.baseUrl}/debug/requests`);
      expect(requests.status).toBe(200);
      expect(await requests.json()).toMatchObject([
        {
          prompt,
          imageInputCount: 1,
          plannedToolName: "echo",
          plannedToolCallId: toolCallId,
          body: { __aimock_truncated: true },
        },
        {
          prompt,
          imageInputCount: 1,
          toolOutput: "independent tool evidence",
          toolOutputCallId: toolCallId,
          toolOutputStructuredError: true,
          body: { __aimock_truncated: true },
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it.each([
    { label: "complete", olderOverflow: false, olderPrompt: "first conversation" },
    { label: "overflow", olderOverflow: true, olderPrompt: "first conversation" },
    { label: "near-budget prompt", olderOverflow: true, olderPrompt: "u".repeat(65_280) },
  ])(
    "keeps tool-result pairing before the selected cursor window ($label)",
    async ({ olderOverflow, olderPrompt }) => {
      const server = await startQaAimockServer();
      const post = async (messages: unknown[]) => {
        const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "aimock/gpt-5.6-luna", stream: false, messages }),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      try {
        await fetch(`${server.baseUrl}/__aimock/fixtures`, { method: "DELETE" });
        const fixtures = [0, 1].map((sequenceIndex) => ({
          match: { sequenceIndex },
          response: { toolCalls: [{ name: "echo", arguments: "{}" }] },
        }));
        const configured = await fetch(`${server.baseUrl}/__aimock/fixtures`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fixtures: [...fixtures, { match: { sequenceIndex: 2 }, response: { content: "done" } }],
          }),
        });
        expect(configured.status).toBe(200);
        const first = await post([
          ...(olderOverflow ? [{ role: "system", content: "s".repeat(70_000) }] : []),
          { role: "user", content: olderPrompt },
        ]);
        await post([{ role: "user", content: "second conversation" }]);
        const firstToolCallId = first.choices[0].message.tool_calls[0].id;
        await post([
          { role: "user", content: "first conversation" },
          first.choices[0].message,
          { role: "tool", content: "first result", tool_call_id: firstToolCallId },
        ]);
        const after = await fetch(`${server.baseUrl}/debug/requests?after=1`);
        expect(after.status).toBe(200);
        const selected = await after.json();
        expect(selected).toHaveLength(2);
        expect(selected[0]).toMatchObject({
          prompt: "second conversation",
          plannedToolName: "echo",
        });
        expect(selected[0]).not.toHaveProperty("plannedToolCallId");
        expect(selected[1]).toMatchObject({ toolOutputCallId: firstToolCallId });
        if (olderOverflow) {
          const all = await fetch(`${server.baseUrl}/debug/requests`);
          expect(all.status).toBe(413);
          const incomplete = await all.json();
          expect(incomplete.requests[0].facts.plannedToolCallId).toBe(firstToolCallId);
          expect(incomplete.requests[0].omittedFields).not.toContain("plannedToolCallId");
        }
      } finally {
        await server.stop();
      }
    },
  );

  it("serves OpenAI Responses text replies and debug request snapshots", async () => {
    const server = await startQaAimockServer({
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "aimock/gpt-5.6-luna",
          stream: false,
          input: [makeResponsesInput("hello aimock")],
        }),
      });
      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as { model?: unknown; status?: unknown };
      expect(responseBody.status).toBe("completed");
      expect(responseBody.model).toBe("aimock/gpt-5.6-luna");

      const debug = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(debug.status).toBe(200);
      const expectedBody = {
        model: "aimock/gpt-5.6-luna",
        messages: [{ role: "user", content: "hello aimock" }],
        stream: false,
        _endpointType: "chat",
      };
      expect(await debug.json()).toEqual({
        raw: JSON.stringify(expectedBody),
        body: expectedBody,
        prompt: "hello aimock",
        allInputText: "hello aimock",
        toolOutput: "",
        model: "aimock/gpt-5.6-luna",
        providerVariant: "openai",
        imageInputCount: 0,
      });
    } finally {
      await server.stop();
    }
  });

  it("records the request list for scenario assertions", async () => {
    const server = await startQaAimockServer({
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "aimock/gpt-5.6-luna",
          stream: false,
          input: [makeResponsesInput("@openclaw explain the QA lab")],
        }),
      });
      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as { status?: unknown };
      expect(responseBody.status).toBe("completed");

      const debug = await fetch(`${server.baseUrl}/debug/requests`);
      expect(debug.status).toBe(200);
      const expectedBody = {
        model: "aimock/gpt-5.6-luna",
        messages: [{ role: "user", content: "@openclaw explain the QA lab" }],
        stream: false,
        _endpointType: "chat",
      };
      expect(await debug.json()).toEqual([
        {
          raw: JSON.stringify(expectedBody),
          body: expectedBody,
          prompt: "@openclaw explain the QA lab",
          allInputText: "@openclaw explain the QA lab",
          toolOutput: "",
          model: "aimock/gpt-5.6-luna",
          providerVariant: "openai",
          imageInputCount: 0,
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("reads requests after a stable debug cursor", async () => {
    const server = await startQaAimockServer({
      host: "127.0.0.1",
      port: 0,
    });
    const post = async (text: string, instructions?: string) => {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "aimock/gpt-5.6-luna",
          stream: false,
          input: [makeResponsesInput(text)],
          instructions,
        }),
      });
      expect(response.status).toBe(200);
    };
    try {
      expect(
        await fetch(`${server.baseUrl}/debug/request-cursor`).then((response) => response.json()),
      ).toEqual({ cursor: 0 });
      const debugRequestLimit = 1_000;
      for (let index = 0; index < debugRequestLimit; index += 1) {
        await post(`aimock cursor ${index}`, index === 0 ? "s".repeat(70_000) : undefined);
      }
      const cursor = await fetch(`${server.baseUrl}/debug/request-cursor`).then((response) =>
        response.json(),
      );
      expect(cursor).toEqual({ cursor: debugRequestLimit });
      expect((await fetch(`${server.baseUrl}/debug/requests`)).status).toBe(413);
      await post("aimock cursor overflow");

      const retained = (await fetch(`${server.baseUrl}/debug/requests`).then((response) =>
        response.json(),
      )) as Array<{ prompt?: unknown }>;
      expect(retained).toHaveLength(debugRequestLimit);
      expect(retained[0]?.prompt).toBe("aimock cursor 1");
      expect(retained.at(-1)?.prompt).toBe("aimock cursor overflow");

      const after = await fetch(`${server.baseUrl}/debug/requests?after=${debugRequestLimit}`);
      expect(after.status).toBe(200);
      const requests = (await after.json()) as Array<{ prompt?: unknown }>;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.prompt).toBe("aimock cursor overflow");

      const expired = await fetch(`${server.baseUrl}/debug/requests?after=0`);
      expect(expired.status).toBe(409);
      expect(await expired.json()).toEqual({
        error: "request cursor expired",
        after: 0,
        oldestCursor: 2,
        latestCursor: debugRequestLimit + 1,
      });

      const futureCursor = debugRequestLimit + 2;
      const future = await fetch(`${server.baseUrl}/debug/requests?after=${futureCursor}`);
      expect(future.status).toBe(409);
      expect(await future.json()).toEqual({
        error: "request cursor is ahead of the latest recorded request",
        after: futureCursor,
        latestCursor: debugRequestLimit + 1,
      });
    } finally {
      await server.stop();
    }
  });

  it("treats OpenAI Codex model refs as OpenAI-compatible snapshots", async () => {
    const server = await startQaAimockServer({
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.6-luna",
          stream: false,
          input: [makeResponsesInput("hello codex-compatible aimock")],
        }),
      });
      expect(response.status).toBe(200);

      const debug = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(debug.status).toBe(200);
      const expectedBody = {
        model: "openai/gpt-5.6-luna",
        messages: [{ role: "user", content: "hello codex-compatible aimock" }],
        stream: false,
        _endpointType: "chat",
      };
      expect(await debug.json()).toEqual({
        raw: JSON.stringify(expectedBody),
        body: expectedBody,
        prompt: "hello codex-compatible aimock",
        allInputText: "hello codex-compatible aimock",
        toolOutput: "",
        model: "openai/gpt-5.6-luna",
        providerVariant: "openai",
        imageInputCount: 0,
      });
    } finally {
      await server.stop();
    }
  });
});
