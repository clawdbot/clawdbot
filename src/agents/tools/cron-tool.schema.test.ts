import {
  findLlamacppGbnfSchemaViolations,
  normalizeToolParameterSchema,
} from "@openclaw/ai/internal/openai";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
// Cron tool schema tests cover the provider-facing parameter shape and runtime
// validation compatibility for cron jobs.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCronTool } from "./cron-tool.js";

/** Unwraps nullable anyOf unions to their object variant so paths can descend. */
function objectVariant(
  node: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!node || node.properties) {
    return node;
  }
  const variants = node.anyOf as Array<Record<string, unknown>> | undefined;
  return variants?.find((entry) => entry.type === "object") ?? node;
}

/** Walk a TypeBox schema by dot-separated property path and return sorted keys. */
function keysAt(schema: Record<string, unknown>, path: string): string[] {
  const leaf = objectVariant(propertyAt(schema, path))?.["properties"] as
    | Record<string, unknown>
    | undefined;
  return leaf ? Object.keys(leaf).toSorted() : [];
}

function propertyAt(
  schema: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  let cursor: Record<string, unknown> | undefined = schema;
  for (const segment of path.split(".")) {
    const props = objectVariant(cursor)?.["properties"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    cursor = props?.[segment];
  }
  return cursor;
}

describe("createCronToolSchema", () => {
  const schema = createCronTool().parameters;
  const schemaRecord = schema as unknown as Record<string, unknown>;
  const providerSchemaRecord = normalizeToolParameterSchema(schema, {
    modelProvider: "gemini",
  }) as unknown as Record<string, unknown>;
  const jjccGeminiSchemaRecord = normalizeToolParameterSchema(schema, {
    modelProvider: "jjcc",
    modelId: "gemini-3.1-pro-preview",
  }) as unknown as Record<string, unknown>;
  const llamacppSchemaRecord = normalizeToolParameterSchema(schema, {
    modelCompat: { toolSchemaProfile: "llamacpp" },
  }) as unknown as Record<string, unknown>;

  // Regression: models like GPT-5.4 rely on these fields to populate job/patch.
  // If a field is removed from this list the test must be updated intentionally.

  it("job exposes the expected top-level fields", () => {
    expect(keysAt(schemaRecord, "job")).toEqual(
      [
        "agentId",
        "declarationKey",
        "deleteAfterRun",
        "delivery",
        "description",
        "displayName",
        "enabled",
        "failureAlert",
        "name",
        "owner",
        "pacing",
        "payload",
        "schedule",
        "sessionKey",
        "sessionTarget",
        "trigger",
        "wakeMode",
      ].toSorted(),
    );
  });

  it("keeps declarationKey portable across model schema converters", () => {
    const declarationKey = propertyAt(schemaRecord, "job.declarationKey");

    expect(declarationKey).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
    // Runtime and gateway validation own the nonblank invariant. An unanchored
    // model-schema pattern prevents llama.cpp from compiling the entire tool.
    expect(declarationKey).not.toHaveProperty("pattern");
  });

  it("projects the complete cron schema into llama.cpp's GBNF subset", () => {
    expect(propertyAt(schemaRecord, "job.trigger.script")).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 65_536,
    });
    expect(propertyAt(llamacppSchemaRecord, "job.trigger.script")).toEqual({
      type: "string",
      minLength: 1,
    });
    expect(findLlamacppGbnfSchemaViolations(llamacppSchemaRecord, "cron.parameters")).toEqual([]);
  });

  it("does not ship a separate patch object schema (#121606)", () => {
    expect(schemaRecord.properties).not.toHaveProperty("patch");
  });

  it("exposes next_check with its relative duration parameter", () => {
    expect(Value.Check(schema, { action: "next_check", in: "15m" })).toBe(true);
    expect(propertyAt(schemaRecord, "in")?.description).toContain("next_check");
    const jobPacing = propertyAt(schemaRecord, "job.pacing");
    const pacingObject = (jobPacing?.anyOf as Array<Record<string, unknown>> | undefined)?.find(
      (entry) => entry.type === "object",
    );
    expect(
      Object.keys((pacingObject?.properties as Record<string, unknown>) ?? {}).toSorted(),
    ).toEqual(["max", "min"]);
  });

  it("exposes bounded cron list pagination", () => {
    expect(propertyAt(schemaRecord, "limit")).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 200,
    });
    expect(propertyAt(schemaRecord, "offset")).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(Value.Check(schema, { action: "list", limit: 200, offset: 200 })).toBe(true);

    for (const invalid of [
      { action: "list", limit: 0 },
      { action: "list", limit: 201 },
      { action: "list", limit: 1.5 },
      { action: "list", offset: -1 },
      { action: "list", offset: 1.5 },
    ]) {
      expect(Value.Check(schema, invalid)).toBe(false);
    }
  });

  it("job.schedule exposes interval, cron, and stream source fields", () => {
    expect(keysAt(schemaRecord, "job.schedule")).toEqual(
      [
        "anchorMs",
        "at",
        "batchMs",
        "command",
        "cwd",
        "everyMs",
        "expr",
        "kind",
        "match",
        "maxBatchBytes",
        "mode",
        "staggerMs",
        "tz",
      ].toSorted(),
    );
    expect(propertyAt(schemaRecord, "job.schedule.kind")?.enum).toContain("stream");
  });

  it("documents wake, context, and session-target fields", () => {
    expect(propertyAt(schemaRecord, "text")?.description).toBe(
      'systemEvent text for action="wake"',
    );
    expect(propertyAt(schemaRecord, "mode")?.description).toBe(
      'Wake mode for action="wake" (default next-heartbeat)',
    );
    expect(propertyAt(schemaRecord, "job.sessionTarget")?.description).toBe(
      "main | isolated | current (agentTurn default) | session:<id>",
    );
    expect(propertyAt(schemaRecord, "job.payload.lightContext")?.description).toBe(
      "Lightweight bootstrap context (skip full workspace context)",
    );
    expect(propertyAt(schemaRecord, "job.payload.allowUnsafeExternalContent")?.description).toBe(
      "Allow untrusted external content in prompt",
    );
  });

  it("marks staggerMs as cron-only in the job schedule schema", () => {
    expect(propertyAt(schemaRecord, "job.schedule.staggerMs")?.description).toBe(
      "Jitter ms (kind=cron)",
    );
  });

  it("advertises numeric cron params with runtime bounds", () => {
    expect(propertyAt(schemaRecord, "job.schedule.everyMs")).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: MAX_DATE_TIMESTAMP_MS,
    });
    expect(propertyAt(schemaRecord, "job.schedule.anchorMs")).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: MAX_DATE_TIMESTAMP_MS,
    });
    expect(propertyAt(schemaRecord, "job.schedule.staggerMs")).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: MAX_DATE_TIMESTAMP_MS,
    });
    expect(propertyAt(schemaRecord, "job.failureAlert.cooldownMs")).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(propertyAt(schemaRecord, "job.failureAlert.after")).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(propertyAt(schemaRecord, "job.payload.timeoutSeconds")).toMatchObject({
      type: "number",
      minimum: 0,
    });
  });

  it("describes cron expressions as local wall-clock time in the supplied timezone", () => {
    // Cron expressions are interpreted by the gateway scheduler; model-facing
    // docs must not encourage UTC conversion by the agent.
    const jobExpr = propertyAt(schemaRecord, "job.schedule.expr");
    const jobTz = propertyAt(schemaRecord, "job.schedule.tz");

    expect(jobExpr?.description).toMatch(/wall-time/i);
    expect(jobExpr?.description).toMatch(/never UTC-convert/i);
    expect(jobExpr?.description).toContain("Gateway local");
    expect(jobExpr?.description).toContain("0 18 * * *");
    expect(jobExpr?.description).toContain("Asia/Shanghai");
    expect(jobTz?.description).toMatch(/wall-clock fields/i);
    expect(jobTz?.description).toContain("Gateway host local timezone");
    expect(jobTz?.description).toContain("Asia/Shanghai");
  });

  it("job.delivery exposes all supported delivery destinations", () => {
    expect(keysAt(schemaRecord, "job.delivery")).toEqual(
      [
        "accountId",
        "bestEffort",
        "channel",
        "completionDestination",
        "failureDestination",
        "mode",
        "threadId",
        "to",
      ].toSorted(),
    );
    const jobCompletion = propertyAt(schemaRecord, "job.delivery.completionDestination");
    const jobCompletionObject = (
      jobCompletion?.anyOf as Array<Record<string, unknown>> | undefined
    )?.find((entry) => entry.type === "object");
    expect(
      Object.keys(
        (jobCompletionObject?.properties as Record<string, unknown> | undefined) ?? {},
      ).toSorted(),
    ).toEqual(["mode", "to"]);
    expect(jobCompletionObject?.required).toEqual(["mode", "to"]);
    expect(
      Value.Check(schema, {
        action: "add",
        job: {
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "agentTurn", message: "run" },
          delivery: {
            mode: "announce",
            completionDestination: { mode: "webhook", to: "https://example.invalid/done" },
          },
        },
      }),
    ).toBe(true);
    // Null is schema-valid (shared update shape); the add path strips it before
    // the strict gateway create contract.
    expect(
      Value.Check(schema, {
        action: "update",
        id: "job-1",
        job: { delivery: { completionDestination: null } },
      }),
    ).toBe(true);
    for (const completionDestination of [
      {},
      { mode: "webhook" },
      { to: "https://example.invalid/done" },
      { mode: "announce", to: "https://example.invalid/done" },
      { mode: "webhook", to: "" },
      "https://example.invalid/done",
    ]) {
      expect(
        Value.Check(schema, {
          action: "add",
          job: {
            schedule: { kind: "every", everyMs: 60_000 },
            payload: { kind: "agentTurn", message: "run" },
            delivery: { mode: "announce", completionDestination },
          },
        }),
      ).toBe(false);
    }
    for (const providerSchema of [providerSchemaRecord, jjccGeminiSchemaRecord]) {
      expect(propertyAt(providerSchema, "job.delivery.completionDestination")).toMatchObject({
        type: "object",
        required: ["mode", "to"],
        description: expect.stringContaining("null clears"),
      });
    }
    expect(
      propertyAt(llamacppSchemaRecord, "job.delivery.completionDestination")?.anyOf,
    ).toContainEqual({ type: "null" });
  });

  it("job.payload exposes conversational and script payload fields", () => {
    expect(keysAt(schemaRecord, "job.payload")).toEqual(
      [
        "allowUnsafeExternalContent",
        "fallbacks",
        "kind",
        "lightContext",
        "message",
        "model",
        "script",
        "text",
        "thinking",
        "toolBudget",
        "toolsAllow",
        "timeoutSeconds",
      ].toSorted(),
    );
  });

  it("job.payload includes fallbacks", () => {
    expect(keysAt(schemaRecord, "job.payload")).toContain("fallbacks");
  });

  it("accepts script payloads in create and update calls", () => {
    expect(
      Value.Check(schema, {
        action: "add",
        job: {
          name: "script job",
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: {
            kind: "script",
            script: "return { notify: 'done' }",
            timeoutSeconds: 300,
            toolBudget: 50,
          },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(schema, {
        action: "update",
        id: "job-1",
        job: { payload: { kind: "script", toolBudget: 75 } },
      }),
    ).toBe(true);
  });

  it("job.failureAlert exposes after, channel, to, cooldownMs, includeSkipped, mode, accountId", () => {
    expect(keysAt(schemaRecord, "job.failureAlert")).toEqual(
      ["accountId", "after", "channel", "cooldownMs", "includeSkipped", "mode", "to"].toSorted(),
    );
  });

  it("job.failureAlert uses plain object type for OpenAPI 3.0 compat", () => {
    const root = schemaRecord.properties as
      | Record<string, { properties?: Record<string, unknown>; type?: unknown }>
      | undefined;
    const jobProps = root?.job?.properties as
      | Record<string, { type?: unknown; description?: string }>
      | undefined;
    const failureAlertSchema = jobProps?.failureAlert;
    // Must be a plain "object" type — not a type array — so providers that
    // enforce an OpenAPI 3.0 subset (e.g. Gemini via GitHub Copilot) accept it.
    expect(failureAlertSchema?.type).toBe("object");
    // The description must mention "false" so LLMs know they can disable alerts.
    expect(failureAlertSchema?.description).toMatch(/false/i);
  });

  it("accepts nullable cron update clears in the runtime schema", () => {
    expect(
      Value.Check(schema, {
        action: "update",
        jobId: "job-1",
        job: {
          agentId: null,
          displayName: null,
          sessionKey: null,
          payload: {
            toolsAllow: null,
          },
        },
      }),
    ).toBe(true);
  });

  it("accepts payload.model and payload.fallbacks null in updates (clear-to-inherit)", () => {
    expect(
      Value.Check(schema, {
        action: "update",
        jobId: "job-1",
        job: {
          payload: {
            model: null,
            fallbacks: null,
          },
        },
      }),
    ).toBe(true);
  });

  it("job.agentId and job.sessionKey project to plain string type for OpenAPI 3.0 compat", () => {
    const root = providerSchemaRecord.properties as
      | Record<string, { properties?: Record<string, unknown> }>
      | undefined;
    const jobProps = root?.job?.properties as
      | Record<string, { type?: unknown; description?: string }>
      | undefined;

    // Provider projection must be plain "string" rather than a nullable union.
    // The raw runtime schema remains nullable so local validation accepts clears.
    expect(jobProps?.agentId?.type).toBe("string");
    expect(jobProps?.agentId?.description).toMatch(/null to clear it/i);
    expect(jobProps?.sessionKey?.type).toBe("string");
    expect(jobProps?.sessionKey?.description).toMatch(/null to clear it/i);
  });

  it("job.payload.toolsAllow projects to plain array type for OpenAPI 3.0 compat", () => {
    const root = providerSchemaRecord.properties as
      | Record<string, { properties?: Record<string, unknown> }>
      | undefined;
    const jobProps = root?.job?.properties as
      | Record<string, { properties?: Record<string, { type?: unknown; description?: string }> }>
      | undefined;

    // Provider-facing schemas must be plain "array" rather than JSON Schema
    // unions so OpenAPI 3.0 subset validators accept them.
    expect(jobProps?.payload?.properties?.toolsAllow?.type).toBe("array");
    expect(jobProps?.payload?.properties?.toolsAllow?.description).toMatch(/null to clear/i);
    expect(jobProps?.payload?.properties?.model?.type).toBe("string");
    expect(jobProps?.payload?.properties?.model?.description).toMatch(/null to clear/i);
  });

  it("projects nullable cron fields for Gemini models behind OpenAI-compatible providers", () => {
    expect(propertyAt(jjccGeminiSchemaRecord, "job.agentId")).toMatchObject({
      type: "string",
    });
    expect(propertyAt(jjccGeminiSchemaRecord, "job.sessionKey")).toMatchObject({
      type: "string",
    });
    expect(propertyAt(jjccGeminiSchemaRecord, "job.payload.toolsAllow")).toMatchObject({
      type: "array",
    });
    expect(propertyAt(jjccGeminiSchemaRecord, "job.delivery.channel")).toMatchObject({
      type: "string",
    });
    expect(JSON.stringify(jjccGeminiSchemaRecord)).not.toContain('"anyOf"');
  });

  // Regression guard: ensure no OpenAPI 3.0 incompatible keywords leak into the
  // serialized provider-facing cron tool schema.
  it("serialized provider schema contains no type-array or not/const keywords", () => {
    const json = JSON.stringify(providerSchemaRecord);
    // type arrays like ["string","null"] are not valid in OpenAPI 3.0
    expect(json).not.toMatch(/"type"\s*:\s*\[/);
    // The "not" composition keyword is not supported by OpenAPI 3.0.
    expect(json).not.toMatch(/"not"\s*:\s*\{/);
  });
});

describe("createCronToolSchema with cron triggers disabled", () => {
  const triggersDisabledConfig = {
    cron: { enabled: true, triggers: { enabled: false } },
  } as OpenClawConfig;
  const tool = createCronTool({ config: triggersDisabledConfig });
  const schemaRecord = tool.parameters as unknown as Record<string, unknown>;

  it("omits trigger from job", () => {
    expect(keysAt(schemaRecord, "job")).not.toContain("trigger");
  });

  it("omits stream schedules from kind enums and drops stream-only fields", () => {
    expect(propertyAt(schemaRecord, "job.schedule.kind")?.enum).toEqual(["at", "every", "cron"]);
    const scheduleKeys = keysAt(schemaRecord, "job.schedule");
    for (const streamField of ["command", "cwd", "mode", "match", "batchMs", "maxBatchBytes"]) {
      expect(scheduleKeys).not.toContain(streamField);
    }
  });

  it("omits script payloads from kind enums and drops script-only fields", () => {
    expect(propertyAt(schemaRecord, "job.payload.kind")?.enum).toEqual([
      "systemEvent",
      "agentTurn",
    ]);
    const payloadKeys = keysAt(schemaRecord, "job.payload");
    expect(payloadKeys).not.toContain("script");
    expect(payloadKeys).not.toContain("toolBudget");
  });

  it("tells the model triggers are unavailable instead of documenting them", () => {
    expect(tool.description).toContain("TRIGGERS DISABLED");
    expect(tool.description).not.toContain("TRIGGER (condition watcher");
    expect(tool.description).not.toContain('kind:"stream"');
    expect(tool.description).not.toContain('kind:"script"');
    expect(tool.description).not.toContain("Silent watcher");
    expect(tool.description).not.toContain("event watchers");
    expect(tool.description).toContain("say it is unsupported");
  });

  it("keeps the full surface when no config is provided", () => {
    const configlessSchema = createCronTool().parameters as unknown as Record<string, unknown>;
    expect(keysAt(configlessSchema, "job")).toContain("trigger");
    expect(propertyAt(configlessSchema, "job.schedule.kind")?.enum).toContain("stream");
  });

  it("gates the surface when config omits cron.triggers entirely (disabled default)", () => {
    const defaultPostureSchema = createCronTool({
      config: { cron: { enabled: true } } as OpenClawConfig,
    }).parameters as unknown as Record<string, unknown>;
    expect(keysAt(defaultPostureSchema, "job")).not.toContain("trigger");
    expect(propertyAt(defaultPostureSchema, "job.schedule.kind")?.enum).toEqual([
      "at",
      "every",
      "cron",
    ]);
  });

  it("still validates a plain reminder add call", () => {
    expect(
      Value.Check(tool.parameters, {
        action: "add",
        job: {
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" },
          payload: { kind: "agentTurn", message: "Morning summary" },
        },
      }),
    ).toBe(true);
  });
});
