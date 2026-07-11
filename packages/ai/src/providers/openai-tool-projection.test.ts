import { describe, expect, it } from "vitest";
import {
  projectOpenAITools,
  reconcileOpenAICompletionsToolChoice,
  reconcileOpenAIResponsesToolChoice,
} from "./openai-tool-projection.js";

describe("OpenAI tool projection", () => {
  it("keeps healthy tools when sibling descriptors or schemas are unreadable", () => {
    const projection = projectOpenAITools([
      {
        get name(): never {
          throw new Error("name exploded");
        },
        parameters: {},
      },
      {
        name: "bad_schema",
        parameters: {
          type: "object",
          get properties(): never {
            throw new Error("properties exploded");
          },
        },
      },
      {
        name: "lookup",
        get description(): never {
          throw new Error("description exploded");
        },
        parameters: { type: "object", properties: {} },
      },
    ]);

    expect(projection.tools).toEqual([
      {
        toolIndex: 2,
        name: "lookup",
        parameters: { type: "object", properties: {} },
      },
    ]);
    expect(projection.diagnostics).toHaveLength(2);
  });

  it("reads optional descriptions once before projecting them", () => {
    let descriptionReads = 0;
    const projection = projectOpenAITools([
      {
        name: "lookup",
        get description() {
          descriptionReads += 1;
          return descriptionReads === 1 ? "Lookup" : Symbol("invalid");
        },
        parameters: {},
      },
    ]);

    expect(projection.tools[0]?.description).toBe("Lookup");
    expect(descriptionReads).toBe(1);
  });

  it("keeps a healthy pinned Responses function choice", () => {
    const projection = projectOpenAITools([{ name: "lookup", parameters: {} }]);

    expect(
      reconcileOpenAIResponsesToolChoice({ type: "function", name: "lookup" }, projection),
    ).toEqual({ type: "function", name: "lookup" });
  });

  it("materializes pinned function choices after one name read", () => {
    const projection = projectOpenAITools([{ name: "lookup", parameters: {} }]);
    let responsesNameReads = 0;
    let completionsNameReads = 0;
    const responsesChoice = {
      type: "function",
      get name() {
        responsesNameReads += 1;
        return responsesNameReads === 1 ? "lookup" : "broken";
      },
    };
    const completionsChoice = {
      type: "function",
      function: {
        get name() {
          completionsNameReads += 1;
          return completionsNameReads === 1 ? "lookup" : "broken";
        },
      },
    };

    expect(reconcileOpenAIResponsesToolChoice(responsesChoice as never, projection)).toEqual({
      type: "function",
      name: "lookup",
    });
    expect(reconcileOpenAICompletionsToolChoice(completionsChoice as never, projection)).toEqual({
      type: "function",
      function: { name: "lookup" },
    });
    expect(responsesNameReads).toBe(1);
    expect(completionsNameReads).toBe(1);
  });

  it("normalizes omitted parameters to an empty schema", () => {
    expect(projectOpenAITools([{ name: "lookup", parameters: undefined }]).tools).toEqual([
      {
        toolIndex: 0,
        name: "lookup",
        parameters: {},
      },
    ]);
  });

  it("quarantines OpenAI tools with unsupported dynamic schema references", () => {
    const projection = projectOpenAITools([
      {
        name: "dynamic",
        parameters: {
          type: "object",
          properties: {
            value: { $dynamicRef: "#value" },
          },
        },
      },
    ]);

    expect(projection.tools).toEqual([]);
    expect(projection.diagnostics).toEqual([
      {
        toolIndex: 0,
        toolName: "dynamic",
        violations: ["dynamic.parameters.properties.value.$dynamicRef"],
      },
    ]);
  });

  it("quarantines an inventory with an unreadable length", () => {
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(projectOpenAITools(tools)).toEqual({
      inputToolCount: 0,
      tools: [],
      diagnostics: [{ toolIndex: 0, violations: ["tool[0] is unreadable"] }],
    });
  });

  it("classifies sparse descriptors as unreadable tools", () => {
    const tools: Array<{ name: string; parameters: Record<string, unknown> }> = [];
    tools.length = 1;

    expect(projectOpenAITools(tools)).toEqual({
      inputToolCount: 1,
      tools: [],
      diagnostics: [{ toolIndex: 0, violations: ["tool[0] is unreadable"] }],
    });
  });

  it("rejects pinned and required choices when their function tools are unavailable", () => {
    const projection = projectOpenAITools([
      {
        name: "broken",
        get parameters(): never {
          throw new Error("parameters exploded");
        },
      },
    ]);

    expect(() =>
      reconcileOpenAIResponsesToolChoice({ type: "function", name: "broken" }, projection),
    ).toThrow('requested unavailable tool "broken"');
    expect(() => reconcileOpenAIResponsesToolChoice("required", projection)).toThrow(
      "no tools survived schema conversion",
    );
    expect(() =>
      reconcileOpenAICompletionsToolChoice(
        { type: "function", function: { name: "broken" } },
        projection,
      ),
    ).toThrow('requested unavailable tool "broken"');
    expect(() => reconcileOpenAICompletionsToolChoice("required", projection)).toThrow(
      "no tools survived schema conversion",
    );
  });

  it("filters official Responses allowed_tools without broadening access", () => {
    const projection = projectOpenAITools([{ name: "lookup", parameters: {} }]);

    expect(
      reconcileOpenAIResponsesToolChoice(
        {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "function", name: "broken" },
            { type: "function", name: "lookup" },
            { type: "web_search_preview" },
          ],
        },
        projection,
      ),
    ).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "lookup" }, { type: "web_search_preview" }],
    });
  });

  it("disables an auto allowed_tools choice when no allowed tools survive", () => {
    const projection = projectOpenAITools([{ name: "lookup", parameters: {} }]);

    expect(
      reconcileOpenAIResponsesToolChoice(
        {
          type: "allowed_tools",
          mode: "auto",
          tools: [{ type: "function", name: "broken" }],
        },
        projection,
      ),
    ).toBe("none");
  });

  it("filters official Chat Completions allowed_tools without broadening access", () => {
    const projection = projectOpenAITools([{ name: "lookup", parameters: {} }]);

    expect(
      reconcileOpenAICompletionsToolChoice(
        {
          type: "allowed_tools",
          allowed_tools: {
            mode: "required",
            tools: [
              { type: "function", function: { name: "broken" } },
              { type: "function", function: { name: "lookup" } },
              { type: "custom", custom: { name: "shell" } },
            ],
          },
        },
        projection,
      ),
    ).toEqual({
      type: "allowed_tools",
      allowed_tools: {
        mode: "required",
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
    });
  });

  it("rejects unsupported top-level Chat Completions custom choices", () => {
    const projection = projectOpenAITools([{ name: "lookup", parameters: {} }]);

    expect(() =>
      reconcileOpenAICompletionsToolChoice(
        { type: "custom", custom: { name: "shell" } },
        projection,
      ),
    ).toThrow("custom tool_choice is unsupported");
  });

  it("disables an auto Chat Completions allowed_tools choice when none survive", () => {
    const projection = projectOpenAITools([{ name: "lookup", parameters: {} }]);

    expect(
      reconcileOpenAICompletionsToolChoice(
        {
          type: "allowed_tools",
          allowed_tools: {
            mode: "auto",
            tools: [
              { type: "function", function: { name: "broken" } },
              { type: "custom", custom: { name: "shell" } },
            ],
          },
        },
        projection,
      ),
    ).toBe("none");
  });

  it("preserves non-function Responses choices", () => {
    const projection = projectOpenAITools([]);

    expect(reconcileOpenAIResponsesToolChoice({ type: "web_search_preview" }, projection)).toEqual({
      type: "web_search_preview",
    });
  });
});
