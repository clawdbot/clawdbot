import { z } from "zod";
import {
  isSafeClawRelativePath,
  isValidClawLanguageTag,
  isValidClawTimezone,
} from "./schema-portability.js";
import {
  CLAW_SETUP_SECRET_REJECTION_MESSAGE,
  containsSensitiveClawSetupValue,
  isSensitiveClawSetupField,
} from "./setup-secret-validation.js";
import {
  DEFAULT_CLAW_SETUP_STRING_LENGTH,
  MAX_CLAW_SETUP_DESCRIPTION_LENGTH,
  MAX_CLAW_SETUP_LABEL_LENGTH,
  MAX_CLAW_SETUP_OPTIONS,
  MAX_CLAW_SETUP_OPTION_VALUE_LENGTH,
  MAX_CLAW_SETUP_SEEDS,
  MAX_CLAW_SETUP_STRING_LENGTH,
} from "./source-limits.js";

const nonEmptyString = z
  .string()
  .min(1)
  .refine(
    (value) => value.length === value.trim().length && value.length > 0,
    "Value must not have leading or trailing whitespace.",
  );
const packageRelativePath = nonEmptyString.refine(isSafeClawRelativePath, {
  message: "Path must be package-relative and must not contain traversal segments.",
});
const setupInputId = nonEmptyString.regex(
  /^[a-z][a-z0-9_]{0,63}$/,
  "Setup input id must start with a lowercase letter and contain only lowercase letters, digits, or underscores.",
);
const setupLabel = nonEmptyString.max(MAX_CLAW_SETUP_LABEL_LENGTH);
const setupDescription = nonEmptyString.max(MAX_CLAW_SETUP_DESCRIPTION_LENGTH).optional();
const setupInputCommonShape = {
  id: setupInputId,
  label: setupLabel,
  description: setupDescription,
  required: z.boolean().optional(),
};

function validateStringInput(
  input: {
    default?: string;
    minLength?: number;
    maxLength: number;
    format?: "timezone" | "language-tag";
  },
  ctx: z.RefinementCtx,
): void {
  if (input.minLength !== undefined && input.minLength > input.maxLength) {
    ctx.addIssue({
      code: "custom",
      path: ["minLength"],
      message: "minLength must not exceed maxLength.",
    });
  }
  if (input.default === undefined) {
    return;
  }
  if (
    (input.minLength !== undefined && input.default.length < input.minLength) ||
    input.default.length > input.maxLength
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["default"],
      message: "Default value must satisfy the declared length constraints.",
    });
  }
  if (
    (input.format === "timezone" && !isValidClawTimezone(input.default)) ||
    (input.format === "language-tag" && !isValidClawLanguageTag(input.default))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["default"],
      message: `Default value is not a valid ${input.format}.`,
    });
  }
}

const setupStringInputSchema = z
  .object({
    ...setupInputCommonShape,
    type: z.literal("string"),
    default: z.string().optional(),
    minLength: z.number().int().nonnegative().max(MAX_CLAW_SETUP_STRING_LENGTH).optional(),
    maxLength: z
      .number()
      .int()
      .positive()
      .max(MAX_CLAW_SETUP_STRING_LENGTH)
      .optional()
      .default(DEFAULT_CLAW_SETUP_STRING_LENGTH),
    format: z.enum(["timezone", "language-tag"]).optional(),
  })
  .strict()
  .superRefine(validateStringInput);

const setupMultilineInputSchema = z
  .object({
    ...setupInputCommonShape,
    type: z.literal("multiline"),
    default: z.string().optional(),
    minLength: z.number().int().nonnegative().max(MAX_CLAW_SETUP_STRING_LENGTH).optional(),
    maxLength: z
      .number()
      .int()
      .positive()
      .max(MAX_CLAW_SETUP_STRING_LENGTH)
      .optional()
      .default(DEFAULT_CLAW_SETUP_STRING_LENGTH),
  })
  .strict()
  .superRefine(validateStringInput);

const setupIntegerInputSchema = z
  .object({
    ...setupInputCommonShape,
    type: z.literal("integer"),
    default: z.number().int().safe().optional(),
    minimum: z.number().int().safe().optional(),
    maximum: z.number().int().safe().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.minimum !== undefined &&
      input.maximum !== undefined &&
      input.minimum > input.maximum
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["minimum"],
        message: "minimum must not exceed maximum.",
      });
    }
    if (
      input.default !== undefined &&
      ((input.minimum !== undefined && input.default < input.minimum) ||
        (input.maximum !== undefined && input.default > input.maximum))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: "Default value must satisfy the declared integer bounds.",
      });
    }
  });

const setupBooleanInputSchema = z
  .object({
    ...setupInputCommonShape,
    type: z.literal("boolean"),
    default: z.boolean().optional(),
  })
  .strict();

const setupChoiceOptionSchema = z
  .object({
    value: nonEmptyString.max(MAX_CLAW_SETUP_OPTION_VALUE_LENGTH),
    label: setupLabel,
  })
  .strict();

function validateChoiceOptions(
  input: { options: Array<{ value: string }>; default?: string | string[] },
  ctx: z.RefinementCtx,
): void {
  const values = new Set<string>();
  input.options.forEach((option, index) => {
    if (values.has(option.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["options", index, "value"],
        message: "Choice option values must be unique.",
      });
    }
    values.add(option.value);
  });
  const defaults = Array.isArray(input.default)
    ? input.default
    : input.default === undefined
      ? []
      : [input.default];
  if (new Set(defaults).size !== defaults.length || defaults.some((value) => !values.has(value))) {
    ctx.addIssue({
      code: "custom",
      path: ["default"],
      message: "Default choices must be unique declared option values.",
    });
  }
}

const setupChoiceInputSchema = z
  .object({
    ...setupInputCommonShape,
    type: z.literal("choice"),
    default: z.string().optional(),
    options: z.array(setupChoiceOptionSchema).min(1).max(MAX_CLAW_SETUP_OPTIONS),
  })
  .strict()
  .superRefine(validateChoiceOptions);

const setupMultiChoiceInputSchema = z
  .object({
    ...setupInputCommonShape,
    type: z.literal("multiChoice"),
    default: z.array(z.string()).optional(),
    options: z.array(setupChoiceOptionSchema).min(1).max(MAX_CLAW_SETUP_OPTIONS),
    minItems: z.number().int().nonnegative().max(MAX_CLAW_SETUP_OPTIONS).optional(),
    maxItems: z.number().int().nonnegative().max(MAX_CLAW_SETUP_OPTIONS).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    validateChoiceOptions(input, ctx);
    if (
      input.minItems !== undefined &&
      input.maxItems !== undefined &&
      input.minItems > input.maxItems
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["minItems"],
        message: "minItems must not exceed maxItems.",
      });
    }
    if (
      input.default !== undefined &&
      ((input.minItems !== undefined && input.default.length < input.minItems) ||
        (input.maxItems !== undefined && input.default.length > input.maxItems))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: "Default choices must satisfy the declared item bounds.",
      });
    }
  });

function validateSetupInputSecrets(
  input: { id: string; label: string; default?: unknown; options?: Array<{ value: string }> },
  ctx: z.RefinementCtx,
): void {
  if (isSensitiveClawSetupField(input)) {
    ctx.addIssue({
      code: "custom",
      path: [isSensitiveClawSetupField({ id: input.id }) ? "id" : "label"],
      message: CLAW_SETUP_SECRET_REJECTION_MESSAGE,
    });
  }
  if (containsSensitiveClawSetupValue(input.default)) {
    ctx.addIssue({
      code: "custom",
      path: ["default"],
      message: CLAW_SETUP_SECRET_REJECTION_MESSAGE,
    });
  }
  input.options?.forEach((option, index) => {
    if (containsSensitiveClawSetupValue(option.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["options", index, "value"],
        message: CLAW_SETUP_SECRET_REJECTION_MESSAGE,
      });
    }
  });
}

export const clawSetupInputSchema = z
  .union([
    setupStringInputSchema,
    setupMultilineInputSchema,
    setupIntegerInputSchema,
    setupBooleanInputSchema,
    setupChoiceInputSchema,
    setupMultiChoiceInputSchema,
  ])
  .superRefine(validateSetupInputSecrets);

export const clawSetupSchema = z
  .object({ inputs: z.array(clawSetupInputSchema).optional().default([]) })
  .strict()
  .default({ inputs: [] });

const personalizationSeedSchema = z
  .object({ source: packageRelativePath, destination: packageRelativePath })
  .strict();

export const clawPersonalizationSchema = z
  .object({
    seeds: z.array(personalizationSeedSchema).max(MAX_CLAW_SETUP_SEEDS).optional().default([]),
  })
  .strict()
  .default({ seeds: [] });
