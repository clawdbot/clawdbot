/** Parses user-provided cron delivery fields into narrow runtime values. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { z, type ZodType } from "zod";

const trimStringPreprocess = (value: unknown) => (typeof value === "string" ? value.trim() : value);

const trimLowercaseStringPreprocess = (value: unknown) =>
  normalizeOptionalLowercaseString(value) ?? value;

const DeliveryModeFieldSchema = z
  .preprocess(trimLowercaseStringPreprocess, z.enum(["deliver", "announce", "none", "webhook"]))
  // "deliver" is the historical CLI spelling; runtime delivery uses announce.
  .transform((value) => (value === "deliver" ? "announce" : value));

/** Accepts non-empty string fields after trimming and lowercasing user-provided delivery input. */
export const LowercaseNonEmptyStringFieldSchema = z.preprocess(
  trimLowercaseStringPreprocess,
  z.string().min(1),
);

/** Accepts non-empty string fields after trimming delivery input without changing case. */
export const TrimmedNonEmptyStringFieldSchema = z.preprocess(
  trimStringPreprocess,
  z.string().min(1),
);

/** Accepts delivery thread identifiers as either trimmed strings or finite numeric ids. */
export const DeliveryThreadIdFieldSchema = z.union([
  TrimmedNonEmptyStringFieldSchema,
  z.number().finite(),
]);

/** Accepts non-negative finite timeout seconds from cron delivery payloads. */
export const TimeoutSecondsFieldSchema = z.number().finite().nonnegative();

type ParsedDeliveryInput = {
  mode?: "announce" | "none" | "webhook";
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
};

/** Parses optional cron delivery fields while dropping invalid values instead of throwing. */
export function parseDeliveryInput(input: Record<string, unknown>): ParsedDeliveryInput {
  return {
    mode: parseOptionalField(DeliveryModeFieldSchema, input.mode),
    channel: parseOptionalField(LowercaseNonEmptyStringFieldSchema, input.channel),
    to: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.to),
    threadId: parseOptionalField(DeliveryThreadIdFieldSchema, input.threadId),
    accountId: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.accountId),
  };
}

/** Returns a parsed field value only when the supplied schema accepts it. */
export function parseOptionalField<T>(schema: ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
