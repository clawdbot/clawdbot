import { describe, expect, it } from "vitest";
import {
  assertCodeModeResponsesToolSurface,
  enforceCodeModeResponsesToolSurface,
  filterCodeModePayloadTools,
  readCodeModePayloadToolName,
  resolveCodeModeResponsesVisibleToolNames,
} from "./openai-transport-params.js";

function withThrowingGetter(field: string): Record<string, unknown> {
  return Object.defineProperty({}, field, {
    enumerable: true,
    get() {
      throw new Error(`unexpected ${field} getter`);
    },
  }) as Record<string, unknown>;
}

describe("OpenAI Code Mode payload tool names", () => {
  it.each([
    ["direct declaration", { name: "exec" }, "exec"],
    ["nested declaration", { function: { name: "wait" } }, "wait"],
    ["nested fallback", { name: 7, function: { name: "computer" } }, "computer"],
    ["inherited declaration", Object.create({ name: "exec" }), undefined],
    ["missing declaration", {}, undefined],
    ["non-record declaration", null, undefined],
  ])("reads a %s", (_description, tool, expected) => {
    expect(readCodeModePayloadToolName(tool)).toBe(expected);
  });

  it.each(["name", "function"])("rejects a throwing %s getter", (field) => {
    expect(readCodeModePayloadToolName(withThrowingGetter(field))).toBeUndefined();
  });

  it("uses only tool names declared in the current request", () => {
    expect(
      resolveCodeModeResponsesVisibleToolNames({
        tools: [
          { name: "exec" },
          { function: { name: "wait" } },
          { name: "computer" },
          withThrowingGetter("name"),
        ],
      } as unknown as Parameters<typeof resolveCodeModeResponsesVisibleToolNames>[0]),
    ).toEqual(new Set(["exec", "wait", "computer"]));
  });
});

describe("OpenAI Code Mode payload tool filtering", () => {
  const visibleToolNames = new Set(["exec", "wait", "computer"]);

  it.each(["functionDeclarations", "function_declarations"] as const)(
    "filters grouped %s without admitting provider-native tools",
    (field) => {
      const payload: { tools: unknown[] } = {
        tools: [
          { type: "function", name: "exec" },
          { type: "function", function: { name: "wait" } },
          {
            [field]: [
              { name: "computer", parameters: { type: "object" } },
              { name: "web_search", parameters: { type: "object" } },
              withThrowingGetter("name"),
            ],
          },
          { type: "web_search" },
          withThrowingGetter("name"),
        ],
      };

      filterCodeModePayloadTools(payload, visibleToolNames);

      expect(payload.tools).toEqual([
        { type: "function", name: "exec" },
        { type: "function", function: { name: "wait" } },
        { [field]: [{ name: "computer", parameters: { type: "object" } }] },
      ]);
    },
  );

  it.each(["functionDeclarations", "function_declarations"] as const)(
    "rejects a throwing %s getter without exposing the group",
    (field) => {
      const payload: { tools: unknown[] } = {
        tools: [{ name: "exec" }, { name: "wait" }, withThrowingGetter(field)],
      };

      expect(() => filterCodeModePayloadTools(payload, visibleToolNames)).not.toThrow();
      expect(payload.tools).toEqual([{ name: "exec" }, { name: "wait" }]);
    },
  );

  it("ignores a throwing payload tools getter", () => {
    expect(() =>
      filterCodeModePayloadTools(withThrowingGetter("tools"), visibleToolNames),
    ).not.toThrow();
  });

  it("keeps the existing Responses and Completions enforcement contract", () => {
    const payload = {
      tools: [{ name: "exec" }, { name: "web_search" }, { type: "web_search" }, { name: "wait" }],
    };

    enforceCodeModeResponsesToolSurface(payload, visibleToolNames);

    expect(payload.tools).toEqual([{ name: "exec" }, { name: "wait" }]);
    expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames)).not.toThrow();
  });

  it("keeps only explicitly allowed hosted tools alongside visible client functions", () => {
    const allowedHostedToolTypes = new Set(["web_search"]);
    const payload = {
      tools: [
        { type: "function", name: "exec" },
        { type: "function", name: "rogue" },
        { type: "web_search" },
        { type: "file_search" },
        { type: "web_search", name: "exec" },
        { type: "web_search", function: { name: "wait" } },
        { type: "web_search", functionDeclarations: [{ name: "exec" }] },
        { type: "function", name: "wait" },
      ],
    };

    filterCodeModePayloadTools(payload, visibleToolNames, allowedHostedToolTypes);
    enforceCodeModeResponsesToolSurface(payload, visibleToolNames, allowedHostedToolTypes);

    expect(payload.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "web_search" },
      { type: "function", name: "wait" },
    ]);
    expect(() =>
      assertCodeModeResponsesToolSurface(payload, visibleToolNames, allowedHostedToolTypes),
    ).not.toThrow();
  });

  it.each(["functionDeclarations", "function_declarations"] as const)(
    "rejects and removes grouped %s from final OpenAI payloads",
    (field) => {
      const payload = {
        tools: [
          { name: "exec" },
          { name: "wait" },
          { [field]: [{ name: "exec" }, { name: "computer" }] },
        ],
      };

      expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames)).toThrow(
        /tool surface violation/,
      );

      enforceCodeModeResponsesToolSurface(payload, visibleToolNames);

      expect(payload.tools).toEqual([{ name: "exec" }, { name: "wait" }]);
      expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames)).not.toThrow();
    },
  );

  it.each([
    [{ name: "exec" }, { name: "exec" }, { name: "wait" }],
    [{ name: "exec" }, { name: "computer" }],
    [{ name: "exec" }, { name: "wait" }, { name: "web_search" }],
  ])("rejects duplicate, missing, or undeclared controls", (...tools) => {
    expect(() => assertCodeModeResponsesToolSurface({ tools }, visibleToolNames)).toThrow(
      /tool surface violation/,
    );
  });

  it.each([
    [
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
      { type: "web_search" },
      { type: "web_search" },
    ],
    [
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
      { type: "file_search" },
    ],
  ])("rejects duplicate or undeclared hosted tools", (...tools) => {
    expect(() =>
      assertCodeModeResponsesToolSurface({ tools }, visibleToolNames, new Set(["web_search"])),
    ).toThrow(/tool surface violation/);
  });

  it("fails closed when the asserted payload tools getter throws", () => {
    expect(() =>
      assertCodeModeResponsesToolSurface(withThrowingGetter("tools"), visibleToolNames),
    ).toThrow(/tool surface violation/);
  });
});
