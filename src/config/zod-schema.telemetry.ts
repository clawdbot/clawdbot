// Defines anonymous feature-usage consent and its generated field metadata.
import { z } from "zod";
import type { TelemetryConfig } from "./types.telemetry.js";
import { configUiMetadata } from "./zod-schema.sensitive.js";

type ConfigSchemaShape<T extends object> = {
  [Key in keyof T]-?: z.ZodType<T[Key]>;
};

const TelemetryConfigShape = {
  enabled: z.boolean().optional().register(configUiMetadata, {
    label: "Anonymous Feature Statistics",
    help: "Shares enabled channel and provider names, plugin count, and recent session count with the daily update check. Disabled by default and always disabled when DO_NOT_TRACK=1.",
  }),
  consentedAt: z.string().datetime().optional().register(configUiMetadata, {
    label: "Feature Statistics Consent Timestamp",
    help: "ISO timestamp recording when the operator accepted or declined anonymous feature statistics. Prevents the setup wizard from asking again.",
  }),
} satisfies ConfigSchemaShape<TelemetryConfig>;

export const TelemetryConfigSchema = z.object(TelemetryConfigShape).strict().optional();

const TELEMETRY_FIELD_SCHEMAS = {
  "telemetry.enabled": TelemetryConfigShape.enabled,
  "telemetry.consentedAt": TelemetryConfigShape.consentedAt,
};

export function projectTelemetryFieldMetadata(field: "label" | "help"): Record<string, string> {
  return Object.fromEntries(
    Object.entries(TELEMETRY_FIELD_SCHEMAS).flatMap(([fieldPath, schema]) => {
      const value = configUiMetadata.get(schema)?.[field];
      return typeof value === "string" ? [[fieldPath, value]] : [];
    }),
  );
}
