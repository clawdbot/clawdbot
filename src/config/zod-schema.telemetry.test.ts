import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { OpenClawSchema } from "./zod-schema.js";
import { projectTelemetryFieldMetadata } from "./zod-schema.telemetry.js";

describe("OpenClawSchema telemetry config", () => {
  it("keeps feature statistics absent by default and preserves explicit consent decisions", () => {
    expect(OpenClawSchema.parse({}).telemetry).toBeUndefined();

    for (const enabled of [false, true]) {
      const telemetry = { enabled, consentedAt: "2026-08-23T12:00:00.000Z" };
      expect(OpenClawSchema.parse({ telemetry }).telemetry).toStrictEqual(telemetry);
    }
  });

  it("rejects unknown telemetry fields and malformed consent timestamps", () => {
    expect(
      OpenClawSchema.safeParse({ telemetry: { enabled: true, installId: "hidden" } }).success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({ telemetry: { consentedAt: "not-a-timestamp" } }).success,
    ).toBe(false);
  });

  it("projects schema-owned labels, help, docs, and the existing configuration tier", () => {
    const response = computeBaseConfigSchemaResponse({ generatedAt: "telemetry-metadata" });
    const labels = projectTelemetryFieldMetadata("label");
    const help = projectTelemetryFieldMetadata("help");

    for (const fieldPath of Object.keys(labels)) {
      expect(response.uiHints[fieldPath]?.label, fieldPath).toBe(labels[fieldPath]);
      expect(response.uiHints[fieldPath]?.help, fieldPath).toBe(help[fieldPath]);
    }

    expect(response.uiHints.telemetry?.docsUrl).toBe("https://docs.openclaw.ai/gateway/telemetry");
    expect(response.uiHints["telemetry.enabled"]?.advanced).toBe(true);
  });
});
