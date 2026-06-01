import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { normalizeToolParameterSchema } from "../agent-tools.schema.js";
import { createCronToolSchema, CronToolSchema } from "./cron-tool.js";

/** Walk a TypeBox schema by dot-separated property path and return sorted keys. */
function keysAt(schema: Record<string, unknown>, path: string): string[] {
  let cursor: Record<string, unknown> | undefined = schema;
  for (const segment of path.split(".")) {
    const props = cursor?.["properties"] as Record<string, Record<string, unknown>> | undefined;
    cursor = props?.[segment];
  }
  const leaf = cursor?.["properties"] as Record<string, unknown> | undefined;
  return leaf ? Object.keys(leaf).toSorted() : [];
}

function propertyAt(
  schema: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  let cursor: Record<string, unknown> | undefined = schema;
  for (const segment of path.split(".")) {
    const props = cursor?.["properties"] as Record<string, Record<string, unknown>> | undefined;
    cursor = props?.[segment];
  }
  return cursor;
}

describe("CronToolSchema", () => {
  const schemaRecord = createCronToolSchema() as unknown as Record<string, unknown>;
  const providerSchemaRecord = normalizeToolParameterSchema(createCronToolSchema(), {
    modelProvider: "gemini",
  }) as unknown as Record<string, unknown>;

  // Regression: models like GPT-5.4 rely on these fields to populate job/patch.
  // If a field is removed from this list the test must be updated intentionally.

  it("job exposes the expected top-level fields", () => {
    expect(keysAt(schemaRecord, "job")).toEqual(
      [
        "agentId",
        "deleteAfterRun",
        "delivery",
        "description",
        "enabled",
        "failureAlert",
        "name",
        "payload",
        "schedule",
        "sessionKey",
        "sessionTarget",
        "wakeMode",
      ].toSorted(),
    );
  });

  it("patch exposes the expected top-level fields", () => {
    expect(keysAt(schemaRecord, "patch")).toEqual(
      [
        "agentId",
        "deleteAfterRun",
        "delivery",
        "description",
        "enabled",
        "failureAlert",
        "name",
        "payload",
        "schedule",
        "sessionKey",
        "sessionTarget",
        "wakeMode",
      ].toSorted(),
    );
  });

  it("job.schedule exposes kind, at, everyMs, anchorMs, expr, tz, staggerMs", () => {
    expect(keysAt(schemaRecord, "job.schedule")).toEqual(
      ["anchorMs", "at", "everyMs", "expr", "kind", "staggerMs", "tz"].toSorted(),
    );
  });

  it("marks staggerMs as cron-only in both job and patch schedule schemas", () => {
    const jobStagger = propertyAt(schemaRecord, "job.schedule.staggerMs");
    const patchStagger = propertyAt(schemaRecord, "patch.schedule.staggerMs");

    expect(jobStagger?.description).toBe("Jitter ms (kind=cron)");
    expect(patchStagger?.description).toBe("Jitter ms (kind=cron)");
  });

  it("advertises numeric cron params with runtime bounds", () => {
    for (const path of ["job.schedule.everyMs", "patch.schedule.everyMs"]) {
      expect(propertyAt(schemaRecord, path)).toMatchObject({ type: "integer", minimum: 1 });
    }
    for (const path of [
      "job.schedule.anchorMs",
      "job.schedule.staggerMs",
      "patch.schedule.anchorMs",
      "patch.schedule.staggerMs",
      "job.failureAlert.cooldownMs",
      "patch.failureAlert.cooldownMs",
    ]) {
      expect(propertyAt(schemaRecord, path)).toMatchObject({ type: "integer", minimum: 0 });
    }
    for (const path of ["job.failureAlert.after", "patch.failureAlert.after"]) {
      expect(propertyAt(schemaRecord, path)).toMatchObject({ type: "integer", minimum: 1 });
    }
    for (const path of ["job.payload.timeoutSeconds", "patch.payload.timeoutSeconds"]) {
      expect(propertyAt(schemaRecord, path)).toMatchObject({ type: "number", minimum: 0 });
    }
  });

  it("describes cron expressions as local wall-clock time in the supplied timezone", () => {
    const jobExpr = propertyAt(schemaRecord, "job.schedule.expr");
    const patchExpr = propertyAt(schemaRecord, "patch.schedule.expr");
    const jobTz = propertyAt(schemaRecord, "job.schedule.tz");
    const patchTz = propertyAt(schemaRecord, "patch.schedule.tz");

    for (const prop of [jobExpr, patchExpr]) {
      expect(prop?.description).toMatch(/wall-clock time/i);
      expect(prop?.description).toMatch(/do not convert/i);
      expect(prop?.description).toContain("Gateway host local timezone");
      expect(prop?.description).toContain("0 18 * * *");
      expect(prop?.description).toContain("Asia/Shanghai");
    }
    for (const prop of [jobTz, patchTz]) {
      expect(prop?.description).toMatch(/wall-clock fields/i);
      expect(prop?.description).toContain("Gateway host local timezone");
      expect(prop?.description).toContain("Asia/Shanghai");
    }
  });

  it("job.delivery exposes mode, channel, to, threadId, bestEffort, accountId, failureDestination", () => {
    expect(keysAt(schemaRecord, "job.delivery")).toEqual(
      [
        "accountId",
        "bestEffort",
        "channel",
        "failureDestination",
        "mode",
        "threadId",
        "to",
      ].toSorted(),
    );
  });

  it("job.payload exposes kind, text, message, model, thinking and extras", () => {
    expect(keysAt(schemaRecord, "job.payload")).toEqual(
      [
        "allowUnsafeExternalContent",
        "fallbacks",
        "kind",
        "lightContext",
        "message",
        "model",
        "text",
        "thinking",
        "toolsAllow",
        "timeoutSeconds",
      ].toSorted(),
    );
  });

  it("job.payload includes fallbacks", () => {
    expect(keysAt(schemaRecord, "job.payload")).toContain("fallbacks");
  });

  it("patch.payload exposes agentTurn fallback overrides", () => {
    expect(keysAt(schemaRecord, "patch.payload")).toEqual(
      [
        "allowUnsafeExternalContent",
        "fallbacks",
        "kind",
        "lightContext",
        "message",
        "model",
        "text",
        "thinking",
        "toolsAllow",
        "timeoutSeconds",
      ].toSorted(),
    );
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
    const schema = jobProps?.failureAlert;
    // Must be a plain "object" type — not a type array — so providers that
    // enforce an OpenAPI 3.0 subset (e.g. Gemini via GitHub Copilot) accept it.
    expect(schema?.type).toBe("object");
    // The description must mention "false" so LLMs know they can disable alerts.
    expect(schema?.description).toMatch(/false/i);
  });

  it("accepts nullable cron patch clears in the runtime schema", () => {
    expect(
      Value.Check(CronToolSchema, {
        action: "update",
        jobId: "job-1",
        patch: {
          agentId: null,
          sessionKey: null,
          payload: {
            toolsAllow: null,
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
    expect(jobProps?.agentId?.description).toMatch(/null to keep it unset/i);
    expect(jobProps?.sessionKey?.type).toBe("string");
    expect(jobProps?.sessionKey?.description).toMatch(/null to clear it/i);
  });

  it("patch.payload.toolsAllow projects to plain array type for OpenAPI 3.0 compat", () => {
    const root = providerSchemaRecord.properties as
      | Record<string, { properties?: Record<string, unknown> }>
      | undefined;
    const patchProps = root?.patch?.properties as
      | Record<string, { properties?: Record<string, { type?: unknown; description?: string }> }>
      | undefined;

    // Provider-facing schemas must be plain "array" rather than JSON Schema
    // unions so OpenAPI 3.0 subset validators accept them.
    expect(patchProps?.payload?.properties?.toolsAllow?.type).toBe("array");
    expect(patchProps?.payload?.properties?.toolsAllow?.description).toMatch(/null to clear/i);
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
