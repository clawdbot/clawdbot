// Defines anonymous feature-usage consent and its generated field metadata.
import { z } from "zod";
import { type ConfigSchemaShape, projectConfigFieldMetadata } from "./schema.field-metadata.js";
import type { TelemetryConfig } from "./types.telemetry.js";
import { configUiMetadata } from "./zod-schema.sensitive.js";

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

export const { labels: TELEMETRY_FIELD_LABELS, help: TELEMETRY_FIELD_HELP } =
  projectConfigFieldMetadata(TelemetryConfigSchema, "telemetry");
