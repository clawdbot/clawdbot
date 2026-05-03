import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

function expectValidationFailure(
  params: Parameters<typeof validateJsonSchemaValue>[0],
): Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }> {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected validation failure");
  }
  return result;
}

function expectValidationIssue(
  result: Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }>,
  path: string,
) {
  const issue = result.errors.find((entry) => entry.path === path);
  expect(issue).toBeDefined();
  return issue;
}

function expectIssueMessageIncludes(
  issue: ReturnType<typeof expectValidationIssue>,
  fragments: readonly string[],
) {
  expect(issue?.message).toEqual(expect.stringContaining(fragments[0] ?? ""));
  fragments.slice(1).forEach((fragment) => {
    expect(issue?.message).toContain(fragment);
  });
}

function expectSuccessfulValidationValue(params: {
  input: Parameters<typeof validateJsonSchemaValue>[0];
  expectedValue: unknown;
}) {
  const result = validateJsonSchemaValue(params.input);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual(params.expectedValue);
  }
}

function expectValidationSuccess(params: Parameters<typeof validateJsonSchemaValue>[0]) {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(true);
}

function expectUriValidationCase(params: {
  input: Parameters<typeof validateJsonSchemaValue>[0];
  ok: boolean;
  expectedPath?: string;
  expectedMessage?: string;
}) {
  if (params.ok) {
    expectValidationSuccess(params.input);
    return;
  }

  const result = expectValidationFailure(params.input);
  const issue = expectValidationIssue(result, params.expectedPath ?? "");
  expect(issue?.message).toContain(params.expectedMessage ?? "");
}

describe("schema validator", () => {
  it("can apply JSON Schema defaults while validating", () => {
    const value = {};
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.defaults.clone",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            default: "auto",
          },
        },
        additionalProperties: false,
      },
      value,
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ mode: "auto" });
      expect(result.value).not.toBe(value);
    }
    expect(value).toEqual({});

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults",
        schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              default: "auto",
            },
          },
          additionalProperties: false,
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { mode: "auto" },
    });
  });

  it("does not clone values when default application has no defaults to inject", () => {
    const value = { mode: "manual" };
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.defaults.no-clone",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
          },
        },
        additionalProperties: false,
      },
      value,
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(value);
    }
  });

  it("recompiles when a stable cache key receives a different schema shape", () => {
    const cacheKey = "schema-validator.test.cache-key-drift";
    expectValidationSuccess({
      cacheKey,
      schema: { type: "string" },
      value: "ok",
    });

    const result = expectValidationFailure({
      cacheKey,
      schema: { type: "number" },
      value: "not-a-number",
    });
    expectValidationIssue(result, "<root>");
  });

  it.each([
    {
      title: "includes allowed values in enum validation errors",
      params: {
        cacheKey: "schema-validator.test.enum",
        schema: {
          type: "object",
          properties: {
            fileFormat: {
              type: "string",
              enum: ["markdown", "html", "json"],
            },
          },
          required: ["fileFormat"],
        },
        value: { fileFormat: "txt" },
      },
      path: "fileFormat",
      messageIncludes: ["(allowed:"],
      allowedValues: ["markdown", "html", "json"],
      hiddenCount: 0,
    },
    {
      title: "includes allowed value in const validation errors",
      params: {
        cacheKey: "schema-validator.test.const",
        schema: {
          type: "object",
          properties: {
            mode: {
              const: "strict",
            },
          },
          required: ["mode"],
        },
        value: { mode: "relaxed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:"],
      allowedValues: ["strict"],
      hiddenCount: 0,
    },
    {
      title: "truncates long allowed-value hints",
      params: {
        cacheKey: "schema-validator.test.enum.truncate",
        schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: [
                "v1",
                "v2",
                "v3",
                "v4",
                "v5",
                "v6",
                "v7",
                "v8",
                "v9",
                "v10",
                "v11",
                "v12",
                "v13",
              ],
            },
          },
          required: ["mode"],
        },
        value: { mode: "not-listed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:", "... (+1 more)"],
      allowedValues: ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12"],
      hiddenCount: 1,
    },
    {
      title: "truncates oversized allowed value entries",
      params: {
        cacheKey: "schema-validator.test.enum.long-value",
        schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["a".repeat(300)],
            },
          },
          required: ["mode"],
        },
        value: { mode: "not-listed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:", "... (+"],
    },
  ])("$title", ({ params, path, messageIncludes, allowedValues, hiddenCount }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, path);

    expectIssueMessageIncludes(issue, messageIncludes);
    if (allowedValues) {
      expect(issue?.allowedValues).toEqual(allowedValues);
      expect(issue?.allowedValuesHiddenCount).toBe(hiddenCount);
    }
  });

  it.each([
    {
      title: "appends missing required property to the structured path",
      params: {
        cacheKey: "schema-validator.test.required.path",
        schema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
              required: ["mode"],
            },
          },
          required: ["settings"],
        },
        value: { settings: {} },
      },
      expectedPath: "settings.mode",
    },
    {
      title: "appends missing dependency property to the structured path",
      params: {
        cacheKey: "schema-validator.test.dependencies.path",
        schema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              dependencies: {
                mode: ["format"],
              },
            },
          },
        },
        value: { settings: { mode: "strict" } },
      },
      expectedPath: "settings.format",
    },
  ])("$title", ({ params, expectedPath }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, expectedPath);

    expect(issue?.allowedValues).toBeUndefined();
  });

  it("sanitizes terminal text while preserving structured fields", () => {
    const maliciousProperty = "evil\nkey\t\x1b[31mred\x1b[0m";
    const result = expectValidationFailure({
      cacheKey: "schema-validator.test.terminal-sanitize",
      schema: {
        type: "object",
        properties: {},
        required: [maliciousProperty],
      },
      value: {},
    });

    const issue = result.errors[0];
    expect(issue).toBeDefined();
    expect(issue?.path).toContain("\n");
    expect(issue?.message).toContain("\n");
    expect(issue?.text).toContain("\\n");
    expect(issue?.text).toContain("\\t");
    expect(issue?.text).not.toContain("\n");
    expect(issue?.text).not.toContain("\t");
    expect(issue?.text).not.toContain("\x1b");
  });

  it.each([
    {
      title: "accepts uri-formatted string schemas for valid urls",
      params: {
        cacheKey: "schema-validator.test.uri.valid",
        schema: {
          type: "object",
          properties: {
            apiRoot: {
              type: "string",
              format: "uri",
            },
          },
          required: ["apiRoot"],
        },
        value: { apiRoot: "https://api.telegram.org" },
      },
      ok: true,
    },
    {
      title: "rejects uri-formatted string schemas for invalid urls",
      params: {
        cacheKey: "schema-validator.test.uri.invalid",
        schema: {
          type: "object",
          properties: {
            apiRoot: {
              type: "string",
              format: "uri",
            },
          },
          required: ["apiRoot"],
        },
        value: { apiRoot: "not a uri" },
      },
      ok: false,
      expectedPath: "apiRoot",
      expectedMessage: "must match format",
    },
  ])(
    "supports uri-formatted string schemas: $title",
    ({ params, ok, expectedPath, expectedMessage }) => {
      expectUriValidationCase({
        input: params,
        ok,
        expectedPath,
        expectedMessage,
      });
    },
  );
});
