import { describe, expect, it, vi } from "vitest";
import type { StructuredInputCompilerOptions } from "./structured-input-boundary.js";
import {
  compileStructuredInputForm,
  compileStructuredInputUrl,
  snapshotStructuredInput,
  type StructuredInputCompileResult,
} from "./structured-input.js";

const baseOptions: StructuredInputCompilerOptions = {
  protocolName: "test",
  allowEmptyForm: true,
  minimumChoiceCount: 1,
  metadata: { secretPath: ["isSecret"] },
};

function compile(
  properties: Record<string, unknown>,
  required: string[] = [],
  options = baseOptions,
): StructuredInputCompileResult {
  return compileStructuredInputForm({
    schema: snapshotStructuredInput({ type: "object", properties, required }),
    message: "Complete the profile",
    fallbackMessage: "Input requested",
    options,
  });
}

function requirePlan(result: StructuredInputCompileResult, kind: "form" | "url" = "form") {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") {
    throw new Error(result.message);
  }
  expect(result.plan.kind).toBe(kind);
  return result.plan;
}

function decodeForm(
  result: StructuredInputCompileResult,
  answers: Record<string, string[]>,
): Record<string, unknown> | string {
  const plan = requirePlan(result);
  if (plan.kind !== "form") {
    throw new Error("expected form plan");
  }
  const entries: Array<[string, unknown]> = [];
  for (const field of plan.fields) {
    const decoded = field.decode(answers[field.question.id] ?? []);
    if (decoded.kind === "invalid") {
      return decoded.message;
    }
    if (decoded.kind === "present") {
      entries.push(...decoded.entries);
    }
  }
  return Object.fromEntries(entries);
}

describe("structured input compiler", () => {
  it("projects bounded primitive fields and decodes defaults, choices, and multi-select", () => {
    const result = compile(
      {
        "Display Name": { type: "string", minLength: 2, maxLength: 20 },
        contact: { type: "string", format: "email" },
        theme: {
          type: "string",
          oneOf: [
            { const: "day", title: "Day" },
            { const: "night", title: "Night", description: "Use dark colors" },
          ],
        },
        enabled: { type: "boolean" },
        count: { type: "integer", minimum: 1, maximum: 9 },
        tags: {
          type: "array",
          items: { type: "string", enum: ["Red", "Blue", "Green"] },
          minItems: 1,
          maxItems: 2,
        },
        score: { type: "number", default: 1.5 },
        optional: { type: "string" },
      },
      ["Display Name", "contact", "theme", "enabled", "count", "tags"],
    );
    const plan = requirePlan(result);
    if (plan.kind !== "form") {
      throw new Error("expected form plan");
    }
    expect(plan.fields.map((field) => field.question.id)).toEqual([
      "display_name",
      "contact",
      "theme",
      "enabled",
      "count",
      "tags",
      "score",
      "optional",
    ]);
    expect(plan.fields[2]?.question.options).toEqual([
      { label: "Day" },
      { label: "Night", description: "Use dark colors" },
    ]);
    expect(
      decodeForm(result, {
        display_name: ["Ada"],
        contact: ["ada@example.com"],
        theme: ["Night"],
        enabled: ["Yes"],
        count: ["7"],
        tags: ["Red", "Blue"],
        score: [],
        optional: [],
      }),
    ).toEqual({
      "Display Name": "Ada",
      contact: "ada@example.com",
      theme: "night",
      enabled: true,
      count: 7,
      tags: ["Red", "Blue"],
      score: 1.5,
    });
  });

  it("normalizes colliding ids and preserves __proto__ as inert accepted content", () => {
    const requestedSchema = JSON.parse(
      '{"type":"object","properties":{"Field Name":{"type":"string"},"field-name":{"type":"string"},"__proto__":{"type":"string"}},"required":["Field Name","field-name","__proto__"]}',
    );
    const result = compileStructuredInputForm({
      schema: snapshotStructuredInput(requestedSchema),
      message: "Input",
      fallbackMessage: "Input",
      options: baseOptions,
    });
    const plan = requirePlan(result);
    if (plan.kind !== "form") {
      throw new Error("expected form plan");
    }
    expect(plan.fields.map((field) => field.question.id)).toEqual([
      "field_name",
      "field_name_2",
      "proto",
    ]);
    const decoded = decodeForm(result, {
      field_name: ["One"],
      field_name_2: ["Two"],
      proto: ["safe"],
    });
    expect(decoded).toMatchObject({ "Field Name": "One", "field-name": "Two" });
    expect(Object.hasOwn(decoded as object, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toBe("safe");
  });

  it("extracts only configured secret metadata and maps codex-acp Other fields", () => {
    const nestedOptions = {
      ...baseOptions,
      metadata: {
        secretPath: ["_meta", "codex", "isSecret"],
        otherAnswerPath: ["_meta", "codex", "isOtherAnswer"],
        otherQuestionIdPath: ["_meta", "codex", "questionId"],
      },
    };
    const result = compile(
      {
        mode: {
          type: "string",
          oneOf: [
            { const: "fast", title: "Fast" },
            { const: "safe", title: "Safe" },
          ],
          _meta: { codex: { isSecret: false } },
        },
        mode__other: {
          type: "string",
          _meta: {
            codex: {
              questionId: "mode",
              isOtherAnswer: true,
              isSecret: true,
            },
          },
        },
        password: { type: "string" },
      },
      [],
      nestedOptions,
    );
    const plan = requirePlan(result);
    if (plan.kind !== "form") {
      throw new Error("expected form plan");
    }
    expect(plan.fields).toHaveLength(2);
    expect(plan.fields[0]?.question).toMatchObject({ id: "mode", isOther: true, isSecret: true });
    expect(plan.fields[1]?.question).toMatchObject({ id: "password", isSecret: false });
    expect(decodeForm(result, { mode: ["Custom"], password: ["public"] })).toEqual({
      mode__other: "Custom",
      password: "public",
    });
  });

  it("gates imagePicker as an explicit extension and projects ids without image data", () => {
    const properties = {
      template: {
        type: "openai/imagePicker",
        items: [
          { id: "monthly", title: "Monthly review", image: "data:image/png;base64,unused" },
          { id: "weekly", title: "Weekly plan", image: "https://invalid/unused" },
        ],
      },
    };
    expect(compile(properties).kind).toBe("unsupported");
    const enabled = compile(properties, ["template"], {
      ...baseOptions,
      allowImagePicker: true,
    });
    const plan = requirePlan(enabled);
    if (plan.kind !== "form") {
      throw new Error("expected form plan");
    }
    expect(plan.fields[0]?.question.options).toEqual([
      { label: "Monthly review" },
      { label: "Weekly plan" },
    ]);
    expect(decodeForm(enabled, { template: ["Monthly review"] })).toEqual({
      template: "monthly",
    });
  });

  it.each([
    [{ type: "string", pattern: "^x$" }, "pattern"],
    [{ type: "integer", minimum: 3, maximum: 1 }, "numeric"],
    [{ type: "string", enum: ["1", "2", "3", "4", "5"] }, "choices"],
    [{ type: "array", items: { type: "string", enum: ["x", "y"] }, maxItems: 3 }, "multi-select"],
  ])("declines unsupported or invalid constraints: %s", (field, message) => {
    const result = compile({ value: field }, ["value"]);
    expect(result).toMatchObject({
      kind: "unsupported",
      message: expect.stringContaining(message),
    });
  });

  it("snapshots own data without invoking accessors and enforces tree bounds", () => {
    const getter = vi.fn(() => "secret");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    expect(snapshotStructuredInput(accessor)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();

    let deep: unknown = "leaf";
    for (let index = 0; index < 10; index += 1) {
      deep = { next: deep };
    }
    expect(snapshotStructuredInput(deep)).toBeUndefined();
    expect(snapshotStructuredInput({ value: "x".repeat(65_537) })).toBeUndefined();
  });

  it("builds literal HTTP(S) URL questions and rejects credentials without fetching", () => {
    const suffix = "a".repeat(1_500);
    const url = `https://example.com/authorize?state=${suffix}`;
    const valid = compileStructuredInputUrl({
      url,
      elicitationId: "auth-1",
      message: "Review authorization",
      fallbackMessage: "Review URL",
      protocolName: "test",
    });
    const plan = requirePlan(valid, "url");
    if (plan.kind !== "url") {
      throw new Error("expected URL plan");
    }
    expect(plan.question.question).toContain(url);
    expect(
      compileStructuredInputUrl({
        url: "https://user:secret@example.com",
        elicitationId: "auth-2",
        message: "Review",
        fallbackMessage: "Review URL",
        protocolName: "test",
      }),
    ).toMatchObject({ kind: "unsupported", message: expect.stringContaining("credentials") });
  });
});
