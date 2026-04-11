import { z, type ZodType } from "zod";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

const trimStringPreprocess = (value: unknown) => (typeof value === "string" ? value.trim() : value);

const trimLowercaseStringPreprocess = (value: unknown) =>
  normalizeOptionalLowercaseString(value) ?? value;

export const DeliveryModeFieldSchema = z
  .preprocess(trimLowercaseStringPreprocess, z.enum(["deliver", "announce", "none", "webhook"]))
  .transform((value) => (value === "deliver" ? "announce" : value));

export const LowercaseNonEmptyStringFieldSchema = z.preprocess(
  trimLowercaseStringPreprocess,
  z.string().min(1),
);

export const TrimmedNonEmptyStringFieldSchema = z.preprocess(
  trimStringPreprocess,
  z.string().min(1),
);

export const DeliveryThreadIdFieldSchema = z.union([
  TrimmedNonEmptyStringFieldSchema,
  z.number().finite(),
]);

export const TimeoutSecondsFieldSchema = z
  .number()
  .finite()
  .transform((value) => Math.max(0, value));

export type ParsedDeliveryInput = {
  mode?: "announce" | "none" | "webhook";
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
};

export function parseDeliveryInput(input: Record<string, unknown>): ParsedDeliveryInput {
  return {
    mode: parseOptionalField(DeliveryModeFieldSchema, input.mode),
    channel: parseOptionalField(LowercaseNonEmptyStringFieldSchema, input.channel),
    to: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.to),
    threadId: parseOptionalField(DeliveryThreadIdFieldSchema, input.threadId),
    accountId: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.accountId),
  };
}

export function parseOptionalField<T>(schema: ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
