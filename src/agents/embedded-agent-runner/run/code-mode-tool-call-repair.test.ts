import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt.tool-call-normalization.js";
import { wrapStreamFnTranslateCodeModeGuestToolCalls } from "./code-mode-tool-call-repair.js";

const GUEST_TOOL_SCHEMAS = new Map<string, unknown>([
  ["read", Type.Object({ path: Type.String() }, { additionalProperties: false })],
  [
    "write",
    Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }),
  ],
  [
    "edit",
    Type.Object(
      {
        path: Type.String(),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
          }),
        ),
      },
      { additionalProperties: false },
    ),
  ],
  ["status", Type.Object({}, { additionalProperties: true })],
  ["run", Type.Object({ command: Type.String() }, { additionalProperties: false })],
]);

const TRANSLATED_READ_CODE =
  'const __openclawResult = await tools["read"](JSON.parse("{\\"path\\":\\"facts.txt\\"}")); console.log("Recovered only the read guest tool call. Re-read the original request and complete every remaining step before answering; do not repeat this completed call. In Code Mode, `await tools.read(...)` returns the text wrapper directly; use `.content` or `.field(key)`, never `[0]` or `result[0].content`. If the user requested a named key\'s value, use the value associated with that exact key, never the key name itself."); return __openclawResult;';

function createFakeStream(params: { events?: unknown[]; resultMessage: unknown }) {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events ?? []) {
          yield event;
        }
      })();
    },
  };
}

async function invoke(
  params: { events?: unknown[]; resultMessage: unknown },
  options?: {
    guestToolNames?: ReadonlySet<string>;
    nativeToolNames?: ReadonlySet<string>;
  },
) {
  const baseFn = vi.fn(() => createFakeStream(params));
  const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
    baseFn as never,
    options?.guestToolNames ?? new Set(GUEST_TOOL_SCHEMAS.keys()),
    GUEST_TOOL_SCHEMAS,
    options?.nativeToolNames,
  );
  const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
  for await (const event of stream) {
    void event;
  }
  return await stream.result();
}

function requireExecCode(result: Awaited<ReturnType<typeof invoke>>): string {
  for (const block of result.content) {
    if (block.type !== "toolCall" || block.name !== "exec") {
      continue;
    }
    const code = block.arguments.code;
    if (typeof code === "string") {
      return code;
    }
  }
  throw new Error("expected an exec tool call with string code");
}

describe("Code Mode outer guest tool-call repair", () => {
  it("keeps an exact visible native method direct without rewriting cwd-like paths", async () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "state/workspaces/cell/facts.txt" },
        },
      ],
    };

    await expect(
      invoke(
        { resultMessage: message },
        {
          nativeToolNames: new Set(["read"]),
        },
      ),
    ).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "state/workspaces/cell/facts.txt" },
        },
      ],
    });
  });

  it.each(["tools.read", "tools/read"])(
    "keeps guest alias %s on the exec bridge when the native tool is visible",
    async (name) => {
      const message = {
        role: "assistant",
        content: [{ type: "toolCall", name, arguments: { path: "facts.txt" } }],
      };

      await expect(
        invoke(
          { resultMessage: message },
          {
            nativeToolNames: new Set(["read"]),
          },
        ),
      ).resolves.toEqual({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "exec",
            arguments: { code: TRANSLATED_READ_CODE },
          },
        ],
      });
    },
  );

  it("repairs structured fields while keeping a visible native edit direct", async () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "edit",
          arguments: {
            path: "editable.txt",
            edits: '[{"oldText":"status=pending","newText":"status=verified"}]',
          },
        },
      ],
    };

    await expect(
      invoke(
        { resultMessage: message },
        {
          nativeToolNames: new Set(["edit"]),
        },
      ),
    ).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "edit",
          arguments: {
            path: "editable.txt",
            edits: [{ oldText: "status=pending", newText: "status=verified" }],
          },
        },
      ],
    });
  });

  it.each([
    { name: "read", nativeToolNames: new Set(["read"]) },
    { name: "tools.read", nativeToolNames: undefined },
  ])("preserves $name when valid arguments stringify to undefined", async (options) => {
    const argumentsWithUndefinedJson = { path: "facts.txt" };
    Object.defineProperty(argumentsWithUndefinedJson, "toJSON", {
      value: () => undefined,
    });
    const toolCall = {
      type: "toolCall",
      name: options.name,
      arguments: argumentsWithUndefinedJson,
      partialArgs: '{"path":"facts.txt"}',
    };
    const message = { role: "assistant", content: [toolCall] };

    await expect(
      invoke({ resultMessage: message }, { nativeToolNames: options.nativeToolNames }),
    ).resolves.toBe(message);
    expect(toolCall).toMatchObject({
      name: options.name,
      arguments: argumentsWithUndefinedJson,
      partialArgs: '{"path":"facts.txt"}',
    });
  });

  it.each(["read", "tools.read", "tools/read"])(
    "translates exact guest method %s into exec",
    async (name) => {
      const message = {
        role: "assistant",
        content: [{ type: "toolCall", name, arguments: { path: "facts.txt" } }],
      };

      await expect(invoke({ resultMessage: message })).resolves.toEqual({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "exec",
            arguments: {
              code: TRANSLATED_READ_CODE,
            },
          },
        ],
      });
    },
  );

  it("waits for tool-call completion before translating streamed projections", async () => {
    const partialCall = {
      type: "toolCall",
      name: "tools.write",
      arguments: {},
    };
    const streamedCall = {
      type: "toolCall",
      name: "tools.write",
      arguments: { path: "result.txt", content: "ok" },
    };
    const endMessageCall = structuredClone(streamedCall);
    const eventMessageCall = structuredClone(streamedCall);
    const finalCall = structuredClone(streamedCall);
    await invoke({
      events: [
        { type: "toolcall_delta", partial: { content: [partialCall] } },
        {
          type: "toolcall_end",
          toolCall: streamedCall,
          partial: { content: [endMessageCall] },
          message: { role: "assistant", content: [eventMessageCall] },
        },
      ],
      resultMessage: { role: "assistant", content: [finalCall] },
    });

    expect(partialCall).toEqual({
      type: "toolCall",
      name: "tools.write",
      arguments: {},
    });
    const translated = {
      type: "toolCall",
      name: "exec",
      arguments: {
        code: 'const __openclawResult = await tools["write"](JSON.parse("{\\"path\\":\\"result.txt\\",\\"content\\":\\"ok\\"}")); console.log("Recovered only the write guest tool call. Re-read the original request and complete every remaining step before answering; do not repeat this completed call. A mutation is not verification: when read-back or verification was requested, do not answer until it succeeds and matches the requested state. In Code Mode, `await tools.read(...)` returns the text wrapper directly; use `.content` or `.field(key)`, never `[0]` or `result[0].content`."); return __openclawResult;',
      },
    };
    expect(streamedCall).toEqual(translated);
    expect(endMessageCall).toEqual(translated);
    expect(eventMessageCall).toEqual(translated);
    expect(finalCall).toEqual(translated);
  });

  it("translates malformed exec arguments when exactly one guest schema matches", async () => {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", name: "exec", arguments: { path: "facts.txt" } }],
    };

    await expect(invoke({ resultMessage: message })).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: {
            code: TRANSLATED_READ_CODE,
          },
        },
      ],
    });
  });

  it("repairs structured fields before matching malformed exec arguments", async () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: {
            path: "editable.txt",
            edits: '[{"oldText":"status=pending","newText":"status=verified"}]',
          },
        },
      ],
    };

    const result = await invoke({ resultMessage: message });
    expect(requireExecCode(result)).toContain(
      'await tools["edit"](JSON.parse("{\\"path\\":\\"editable.txt\\",\\"edits\\":[{\\"oldText\\":\\"status=pending\\",\\"newText\\":\\"status=verified\\"}]}"))',
    );
  });

  it("keeps inferred malformed exec arguments on the guest bridge", async () => {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", name: "exec", arguments: { path: "facts.txt" } }],
    };

    await expect(
      invoke(
        { resultMessage: message },
        {
          nativeToolNames: new Set(["read"]),
        },
      ),
    ).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: {
            code: TRANSLATED_READ_CODE,
          },
        },
      ],
    });
  });

  it("does not infer malformed exec arguments from an excluded guest schema", async () => {
    const toolCall = {
      type: "toolCall",
      name: "exec",
      arguments: {
        path: "editable.txt",
        edits: '[{"oldText":"status=pending","newText":"status=verified"}]',
      },
    };
    const message = {
      role: "assistant",
      content: [toolCall],
    };
    const expected = structuredClone(message);

    await expect(
      invoke(
        { resultMessage: message },
        {
          guestToolNames: new Set(["read"]),
          nativeToolNames: new Set(["edit"]),
        },
      ),
    ).resolves.toEqual(expected);
    expect(toolCall.name).toBe("exec");
    expect(toolCall.arguments).toEqual(expected.content[0]?.arguments);
  });

  it("repairs stringified structured fields against the guest tool schema", async () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "edit",
          arguments: {
            path: "editable.txt",
            edits: '[{"oldText":"status=pending","newText":"status=verified"}]',
          },
        },
      ],
    };

    const result = await invoke({ resultMessage: message });
    expect(requireExecCode(result)).toContain(
      'JSON.parse("{\\"path\\":\\"editable.txt\\",\\"edits\\":[{\\"oldText\\":\\"status=pending\\",\\"newText\\":\\"status=verified\\"}]}")',
    );
  });

  it("lifts a misplaced edit path out of stringified edit items", async () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "edit",
          arguments: {
            edits:
              '[{"newText":"status=verified","oldText":"status=pending","path":"editable.txt"}]',
          },
        },
      ],
    };

    const result = await invoke({ resultMessage: message });
    expect(requireExecCode(result)).toContain(
      'JSON.parse("{\\"edits\\":[{\\"newText\\":\\"status=verified\\",\\"oldText\\":\\"status=pending\\"}],\\"path\\":\\"editable.txt\\"}")',
    );
  });

  it("promotes truncated guest XML and translates every terminal projection to exec", async () => {
    const rawToolText = [
      "<function=tools.read>",
      "<parameter=path>",
      "facts.txt",
      "</parameter>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    };
    const doneMessage = structuredClone(resultMessage);
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: rawToolText },
          { type: "done", reason: "stop", message: doneMessage },
        ],
        resultMessage,
      }),
    );
    const promoted = wrapStreamFnPromoteStandaloneTextToolCalls(
      baseFn as never,
      new Set(["exec"]),
      {
        additionalAllowedToolNames: new Set(["tools.read"]),
        allowMissingXmlFunctionCloseForAdditionalTools: true,
      },
    );
    const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
      promoted,
      new Set(GUEST_TOOL_SCHEMAS.keys()),
      GUEST_TOOL_SCHEMAS,
    );
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();
    const expectedArguments = {
      code: TRANSLATED_READ_CODE,
    };

    expect(result).toMatchObject({
      content: [{ type: "toolCall", name: "exec", arguments: expectedArguments }],
      stopReason: "toolUse",
    });
    const toolCallEnd = events.find(
      (event) => (event as { type?: unknown }).type === "toolcall_end",
    ) as { toolCall?: unknown };
    expect(toolCallEnd.toolCall).toMatchObject({
      name: "exec",
      arguments: expectedArguments,
    });
    const doneEvent = events.find((event) => (event as { type?: unknown }).type === "done") as {
      message?: { content?: unknown[] };
    };
    expect(doneEvent.message?.content?.[0]).toMatchObject({
      name: "exec",
      arguments: expectedArguments,
    });
    expect(JSON.stringify({ events, result })).not.toContain(rawToolText);
  });

  it("translates after provider argument repair reconstructs streamed exec arguments", async () => {
    const partialCall = {
      type: "toolCall",
      name: "exec",
      arguments: {},
      partialArgs: "",
    };
    const streamedCall = structuredClone(partialCall);
    const finalCall = structuredClone(partialCall);
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"facts.txt"}',
            partial: { content: [partialCall] },
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedCall,
            partial: { content: [partialCall] },
          },
        ],
        resultMessage: { role: "assistant", content: [finalCall] },
      }),
    );
    const repaired = wrapStreamFnRepairMalformedToolCallArguments(baseFn as never);
    const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
      repaired,
      new Set(["read", "write"]),
      GUEST_TOOL_SCHEMAS,
    );
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));

    for await (const event of stream) {
      void event;
    }
    const result = await stream.result();
    const expectedArguments = {
      code: TRANSLATED_READ_CODE,
    };
    expect(streamedCall).toMatchObject({
      name: "exec",
      arguments: expectedArguments,
      partialArgs: JSON.stringify(expectedArguments),
    });
    expect(partialCall).toMatchObject({
      name: "exec",
      arguments: expectedArguments,
      partialArgs: JSON.stringify(expectedArguments),
    });
    expect(result).toMatchObject({
      content: [
        {
          name: "exec",
          arguments: expectedArguments,
          partialArgs: JSON.stringify(expectedArguments),
        },
      ],
    });
  });

  it("leaves malformed exec arguments unchanged when guest schemas are ambiguous", async () => {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", name: "exec", arguments: { path: "facts.txt" } }],
    };
    const baseFn = vi.fn(() => createFakeStream({ resultMessage: message }));
    const ambiguousSchemas = new Map(GUEST_TOOL_SCHEMAS);
    ambiguousSchemas.set(
      "inspect",
      Type.Object({ path: Type.String() }, { additionalProperties: false }),
    );
    const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
      baseFn as never,
      new Set(["read", "write", "status", "inspect"]),
      ambiguousSchemas,
    );
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));

    await expect(stream.result()).resolves.toBe(message);
    expect(message.content[0]?.arguments).toEqual({ path: "facts.txt" });
  });

  it("never translates the outer Code Mode controls", async () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: { code: 'return await tools["read"]({"path":"facts.txt"});' },
        },
      ],
    };
    const baseFn = vi.fn(() => createFakeStream({ resultMessage: message }));
    const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
      baseFn as never,
      new Set(["read", "exec"]),
      GUEST_TOOL_SCHEMAS,
    );
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));

    await expect(stream.result()).resolves.toBe(message);
    expect(message.content[0]?.arguments).toEqual({
      code: 'return await tools["read"]({"path":"facts.txt"});',
    });
  });

  it("preserves own __proto__ keys as JSON data", async () => {
    const argumentsWithProto = JSON.parse(
      '{"__proto__":{"safe":true},"nested":{"__proto__":"value"}}',
    );
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: argumentsWithProto }],
    };

    const result = await invoke({ resultMessage: message });
    expect(requireExecCode(result)).toBe(
      'const __openclawResult = await tools["read"](JSON.parse("{\\"__proto__\\":{\\"safe\\":true},\\"nested\\":{\\"__proto__\\":\\"value\\"}}")); console.log("Recovered only the read guest tool call. Re-read the original request and complete every remaining step before answering; do not repeat this completed call. In Code Mode, `await tools.read(...)` returns the text wrapper directly; use `.content` or `.field(key)`, never `[0]` or `result[0].content`. If the user requested a named key\'s value, use the value associated with that exact key, never the key name itself."); return __openclawResult;',
    );
  });

  it.each([
    { name: "tools.unknown", arguments: {} },
    { name: "tools.read.extra", arguments: {} },
    { name: "read", arguments: "fragment" },
    { name: "exec", arguments: {} },
    { name: "exec", arguments: { code: "return 1;" } },
    { name: "exec", arguments: { command: "return 1;" } },
    { name: "exec", arguments: { language: "javascript", path: "facts.txt" } },
  ])("leaves unsupported calls unchanged: $name", async (toolCall) => {
    const message = { role: "assistant", content: [{ type: "toolCall", ...toolCall }] };
    const expected = structuredClone(message);

    await expect(invoke({ resultMessage: message })).resolves.toEqual(expected);
  });
});
