import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { stableStringify } from "../agents/stable-stringify.js";
import { assertNoSymlinkParents } from "../infra/fs-safe-advanced.js";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { isValidClawLanguageTag, isValidClawTimezone } from "./schema-portability.js";
import {
  CLAW_SETUP_SECRET_REJECTION_MESSAGE,
  containsSensitiveClawSetupValue,
  isSensitiveClawSetupField,
} from "./setup-secret-validation.js";
import {
  MAX_CLAW_SETUP_RENDERED_BYTES,
  MAX_CLAW_SETUP_RENDERED_SEED_BYTES,
  MAX_CLAW_SETUP_TEMPLATE_BYTES,
} from "./source-limits.js";
import {
  CLAW_SETUP_SCHEMA_VERSION,
  type ClawDiagnostic,
  type ClawManifest,
  type ClawManifestV2,
  type ClawSetupInput,
  type ClawSetupPlan,
  type ClawSetupTemplateSnapshot,
} from "./types.js";

const INPUT_TOKEN = /\{\{\s*input\.([a-z][a-z0-9_]{0,63})\s*\}\}/g;

type TemplateRead = {
  source: string;
  destination: string;
  raw: Buffer;
  content: string;
  snapshot: ClawSetupTemplateSnapshot;
};

type ResolvedAnswer = {
  value: string | number | boolean | string[] | undefined;
  source: "explicit" | "default" | "absent";
};

export type ClawSetupAppliedAnswer = {
  id: string;
  value: Exclude<ResolvedAnswer["value"], undefined>;
  source: Exclude<ResolvedAnswer["source"], "absent">;
};

export type ClawSetupRenderedSeed = {
  destination: string;
  content: Buffer;
  digest: string;
  inputIds: string[];
  source: string;
};

export type ClawSetupMaterialization = {
  schemaDigest: string;
  answerDigest: string;
  answers: ClawSetupAppliedAnswer[];
  seeds: ClawSetupRenderedSeed[];
};

function diagnostic(
  code: string,
  phase: ClawDiagnostic["phase"],
  path: string,
  message: string,
): ClawDiagnostic {
  return { level: "error", code, phase, path, message };
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function templateInputIds(
  content: string,
): { ok: true; inputIds: string[] } | { ok: false; message: string } {
  const inputIds: string[] = [];
  const seen = new Set<string>();
  const withoutTokens = content.replace(INPUT_TOKEN, (_token, inputId: string) => {
    if (!seen.has(inputId)) {
      seen.add(inputId);
      inputIds.push(inputId);
    }
    return "";
  });
  if (withoutTokens.includes("{{") || withoutTokens.includes("}}")) {
    return {
      ok: false,
      message: "Templates support only {{ input.<id> }} scalar interpolation.",
    };
  }
  return { ok: true, inputIds };
}

function maxRenderedValueBytes(input: ClawSetupInput): number {
  switch (input.type) {
    case "string":
    case "multiline":
      return input.maxLength * 8;
    case "integer":
      return 32;
    case "boolean":
      return 5;
    case "choice":
      return Math.max(...input.options.map((option) => option.value.length * 8));
    case "multiChoice": {
      const maxItems = input.maxItems ?? input.options.length;
      const maxOptionBytes = Math.max(...input.options.map((option) => option.value.length * 8));
      return maxItems * (maxOptionBytes + 3);
    }
  }
  throw new Error(`Unsupported setup input type: ${String((input as { type?: unknown }).type)}`);
}

function maxRenderedTemplateBytes(content: string, inputs: Map<string, ClawSetupInput>): number {
  let size = 0;
  let cursor = 0;
  for (const match of content.matchAll(INPUT_TOKEN)) {
    const token = match[0];
    const index = match.index;
    const inputId = match[1];
    size += Buffer.byteLength(content.slice(cursor, index), "utf8");
    size += inputId ? maxRenderedValueBytes(inputs.get(inputId)!) : 0;
    cursor = index + token.length;
  }
  return size + Buffer.byteLength(content.slice(cursor), "utf8");
}

export async function readClawSetupTemplates(params: {
  manifest: ClawManifest;
  packageRoot: string;
}): Promise<
  | { ok: true; templates: TemplateRead[]; snapshots: ClawSetupTemplateSnapshot[] }
  | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  if (params.manifest.schemaVersion !== CLAW_SETUP_SCHEMA_VERSION) {
    return { ok: true, templates: [], snapshots: [] };
  }
  const inputs = new Map(params.manifest.setup.inputs.map((input) => [input.id, input]));
  const referencedInputIds = new Set<string>();
  const templates: TemplateRead[] = [];
  const diagnostics: ClawDiagnostic[] = [];
  const sourceRoot = await fsSafeRoot(params.packageRoot);
  let aggregateSourceBytes = 0;
  let aggregateRenderedBytes = 0;

  for (const [index, seed] of params.manifest.personalization.seeds.entries()) {
    const path = `$.personalization.seeds[${index}].source`;
    try {
      await assertNoSymlinkParents({
        rootDir: params.packageRoot,
        targetPath: resolve(params.packageRoot, seed.source),
        allowMissing: false,
        messagePrefix: "Personalization template",
      });
      const read = await sourceRoot.read(seed.source, {
        hardlinks: "reject",
        maxBytes: MAX_CLAW_SETUP_TEMPLATE_BYTES,
        nonBlockingRead: true,
        symlinks: "reject",
      });
      aggregateSourceBytes += read.buffer.byteLength;
      if (aggregateSourceBytes > MAX_CLAW_SETUP_RENDERED_BYTES) {
        diagnostics.push(
          diagnostic(
            "setup_templates_too_large",
            "parse",
            "$.personalization.seeds",
            `Setup templates exceed ${MAX_CLAW_SETUP_RENDERED_BYTES} aggregate bytes.`,
          ),
        );
        break;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
      } catch {
        diagnostics.push(
          diagnostic(
            "setup_template_invalid_utf8",
            "parse",
            path,
            `Personalization template ${JSON.stringify(seed.source)} must contain valid UTF-8.`,
          ),
        );
        continue;
      }
      const parsed = templateInputIds(content);
      if (!parsed.ok) {
        diagnostics.push(diagnostic("setup_template_invalid", "schema", path, parsed.message));
        continue;
      }
      const unknownInputId = parsed.inputIds.find((inputId) => !inputs.has(inputId));
      if (unknownInputId) {
        diagnostics.push(
          diagnostic(
            "setup_template_unknown_input",
            "schema",
            path,
            `Template references undeclared setup input ${JSON.stringify(unknownInputId)}.`,
          ),
        );
        continue;
      }
      parsed.inputIds.forEach((inputId) => referencedInputIds.add(inputId));
      const worstCaseBytes = maxRenderedTemplateBytes(content, inputs);
      aggregateRenderedBytes += worstCaseBytes;
      if (worstCaseBytes > MAX_CLAW_SETUP_RENDERED_SEED_BYTES) {
        diagnostics.push(
          diagnostic(
            "setup_seed_render_too_large",
            "schema",
            path,
            `Personalization seed can render beyond ${MAX_CLAW_SETUP_RENDERED_SEED_BYTES} bytes.`,
          ),
        );
        continue;
      }
      const snapshot: ClawSetupTemplateSnapshot = {
        sourcePath: seed.source,
        realPath: read.realPath,
        byteLength: read.buffer.byteLength,
        digest: digest(read.buffer),
        inputIds: parsed.inputIds,
      };
      templates.push({ ...seed, raw: read.buffer, content, snapshot });
    } catch (error) {
      const tooLarge = error instanceof FsSafeError && error.code === "too-large";
      diagnostics.push(
        diagnostic(
          tooLarge ? "setup_template_too_large" : "setup_template_invalid",
          "parse",
          path,
          tooLarge
            ? `Personalization template ${JSON.stringify(seed.source)} exceeds ${MAX_CLAW_SETUP_TEMPLATE_BYTES} bytes.`
            : `Personalization template ${JSON.stringify(seed.source)} must be a regular package-local file.`,
        ),
      );
    }
  }

  if (aggregateRenderedBytes > MAX_CLAW_SETUP_RENDERED_BYTES) {
    diagnostics.push(
      diagnostic(
        "setup_seeds_render_too_large",
        "schema",
        "$.personalization.seeds",
        `Personalization seeds can render beyond ${MAX_CLAW_SETUP_RENDERED_BYTES} aggregate bytes.`,
      ),
    );
  }
  params.manifest.setup.inputs.forEach((input, index) => {
    if (!referencedInputIds.has(input.id)) {
      diagnostics.push(
        diagnostic(
          "setup_input_unused",
          "schema",
          `$.setup.inputs[${index}].id`,
          `Setup input ${JSON.stringify(input.id)} must be referenced by a seed template.`,
        ),
      );
    }
  });
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, templates, snapshots: templates.map((template) => template.snapshot) };
}

function validateAnswer(input: ClawSetupInput, value: unknown): string | undefined {
  switch (input.type) {
    case "string":
    case "multiline": {
      if (typeof value !== "string") {
        return "Expected a string value.";
      }
      if (
        (input.minLength !== undefined && value.length < input.minLength) ||
        value.length > input.maxLength
      ) {
        return `Value length must be between ${input.minLength ?? 0} and ${input.maxLength}.`;
      }
      if (input.type === "string" && input.format === "timezone" && !isValidClawTimezone(value)) {
        return "Expected a valid IANA timezone.";
      }
      if (
        input.type === "string" &&
        input.format === "language-tag" &&
        !isValidClawLanguageTag(value)
      ) {
        return "Expected a valid BCP 47 language tag.";
      }
      return undefined;
    }
    case "integer":
      if (!Number.isSafeInteger(value)) {
        return "Expected a safe integer value.";
      }
      if (
        (input.minimum !== undefined && (value as number) < input.minimum) ||
        (input.maximum !== undefined && (value as number) > input.maximum)
      ) {
        return `Value must be between ${input.minimum ?? Number.MIN_SAFE_INTEGER} and ${input.maximum ?? Number.MAX_SAFE_INTEGER}.`;
      }
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : "Expected a boolean value.";
    case "choice":
      return typeof value === "string" && input.options.some((option) => option.value === value)
        ? undefined
        : "Expected one declared choice value.";
    case "multiChoice": {
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string") ||
        new Set(value).size !== value.length ||
        value.some((item) => !input.options.some((option) => option.value === item))
      ) {
        return "Expected unique declared choice values.";
      }
      if (
        (input.minItems !== undefined && value.length < input.minItems) ||
        (input.maxItems !== undefined && value.length > input.maxItems)
      ) {
        return `Choice count must be between ${input.minItems ?? 0} and ${input.maxItems ?? input.options.length}.`;
      }
      return undefined;
    }
  }
  return "Unsupported setup input type.";
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replace(/([-`*_{}[\]()<>#+.!|])/g, "\\$1");
}

function renderAnswer(answer: ResolvedAnswer): string {
  const value = answer.value;
  if (value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => `- ${escapeMarkdown(item)}`).join("\n");
  }
  return escapeMarkdown(value);
}

export async function buildClawSetupPlan(params: {
  manifest: ClawManifestV2;
  packageRoot: string;
  answers?: unknown;
  seedDestinations?: ReadonlySet<string>;
}): Promise<{
  plan: ClawSetupPlan;
  materialization?: ClawSetupMaterialization;
}> {
  const read = await readClawSetupTemplates(params);
  const schemaDigest = digest(
    stableStringify({
      setup: params.manifest.setup,
      personalization: params.manifest.personalization,
    }),
  );
  if (!read.ok) {
    return {
      plan: {
        schemaDigest,
        answerDigest: digest(stableStringify([])),
        valid: false,
        inputs: params.manifest.setup.inputs,
        providedInputIds: [],
        defaultedInputIds: [],
        missingOptionalInputIds: [],
        seeds: params.manifest.personalization.seeds.map((seed) => ({
          ...seed,
          inputIds: [],
          blocked: true,
        })),
        diagnostics: read.diagnostics,
      },
    };
  }
  const selectedDestinations = params.seedDestinations;
  const selectedTemplates = selectedDestinations
    ? read.templates.filter((template) => selectedDestinations.has(template.destination))
    : read.templates;
  const activeInputIds = new Set(
    selectedTemplates.flatMap((template) => template.snapshot.inputIds),
  );

  const diagnostics: ClawDiagnostic[] = [];
  const answers =
    params.answers === undefined
      ? {}
      : params.answers !== null &&
          typeof params.answers === "object" &&
          !Array.isArray(params.answers)
        ? (params.answers as Record<string, unknown>)
        : undefined;
  if (!answers) {
    diagnostics.push(
      diagnostic("setup_answers_invalid", "plan", "$.answers", "Answers must be a JSON object."),
    );
  }
  const inputs = new Map(params.manifest.setup.inputs.map((input) => [input.id, input]));
  for (const inputId of Object.keys(answers ?? {})) {
    if (!inputs.has(inputId)) {
      diagnostics.push(
        diagnostic(
          "setup_answer_unknown",
          "plan",
          `$.answers.${inputId}`,
          `Answer does not match a declared setup input ${JSON.stringify(inputId)}.`,
        ),
      );
    }
  }

  const resolved = new Map<string, ResolvedAnswer>();
  for (const input of params.manifest.setup.inputs) {
    if (!activeInputIds.has(input.id)) {
      resolved.set(input.id, { value: undefined, source: "absent" });
      continue;
    }
    const explicit = answers ? Object.hasOwn(answers, input.id) : false;
    const value = explicit ? answers?.[input.id] : input.default;
    const source = explicit ? "explicit" : input.default !== undefined ? "default" : "absent";
    if (value === undefined) {
      if (input.required) {
        diagnostics.push(
          diagnostic(
            "setup_answer_required",
            "plan",
            `$.answers.${input.id}`,
            `${input.label} is required before this Claw can be added.`,
          ),
        );
      }
      resolved.set(input.id, { value: undefined, source });
      continue;
    }
    if (isSensitiveClawSetupField(input) || containsSensitiveClawSetupValue(value)) {
      diagnostics.push(
        diagnostic(
          "setup_answer_sensitive",
          "plan",
          `$.answers.${input.id}`,
          CLAW_SETUP_SECRET_REJECTION_MESSAGE,
        ),
      );
      resolved.set(input.id, { value: undefined, source });
      continue;
    }
    const message = validateAnswer(input, value);
    if (message) {
      diagnostics.push(
        diagnostic("setup_answer_invalid", "plan", `$.answers.${input.id}`, message),
      );
      resolved.set(input.id, { value: undefined, source });
      continue;
    }
    resolved.set(input.id, {
      value: value as ResolvedAnswer["value"],
      source,
    });
  }

  const answerDigest = digest(
    stableStringify(
      params.manifest.setup.inputs
        .filter((input) => activeInputIds.has(input.id))
        .map((input) => {
          const answer = resolved.get(input.id)!;
          return { id: input.id, value: answer.value, source: answer.source };
        }),
    ),
  );
  const renderedSeeds: ClawSetupRenderedSeed[] = [];
  const seedPlans: ClawSetupPlan["seeds"] = [];
  let aggregateRenderedBytes = 0;
  for (const template of selectedTemplates) {
    const index = read.templates.indexOf(template);
    const rendered = template.content.replace(INPUT_TOKEN, (_token, inputId: string) =>
      renderAnswer(resolved.get(inputId) ?? { value: undefined, source: "absent" }),
    );
    const content = Buffer.from(rendered, "utf8");
    aggregateRenderedBytes += content.byteLength;
    const blocked =
      diagnostics.length > 0 || content.byteLength > MAX_CLAW_SETUP_RENDERED_SEED_BYTES;
    if (content.byteLength > MAX_CLAW_SETUP_RENDERED_SEED_BYTES) {
      diagnostics.push(
        diagnostic(
          "setup_seed_render_too_large",
          "plan",
          `$.personalization.seeds[${index}].source`,
          `Rendered personalization seed exceeds ${MAX_CLAW_SETUP_RENDERED_SEED_BYTES} bytes.`,
        ),
      );
    }
    seedPlans.push({
      source: template.source,
      destination: template.destination,
      inputIds: template.snapshot.inputIds,
      ...(blocked ? {} : { renderedByteLength: content.byteLength, digest: digest(content) }),
      blocked,
    });
    if (!blocked) {
      renderedSeeds.push({
        destination: template.destination,
        content,
        digest: digest(content),
        inputIds: template.snapshot.inputIds,
        source: template.source,
      });
    }
  }
  if (aggregateRenderedBytes > MAX_CLAW_SETUP_RENDERED_BYTES) {
    diagnostics.push(
      diagnostic(
        "setup_seeds_render_too_large",
        "plan",
        "$.personalization.seeds",
        `Rendered personalization seeds exceed ${MAX_CLAW_SETUP_RENDERED_BYTES} aggregate bytes.`,
      ),
    );
    renderedSeeds.length = 0;
    seedPlans.forEach((seed) => {
      seed.blocked = true;
      delete seed.digest;
      delete seed.renderedByteLength;
    });
  }

  return {
    plan: {
      schemaDigest,
      answerDigest,
      valid: diagnostics.length === 0,
      inputs: params.manifest.setup.inputs,
      providedInputIds: params.manifest.setup.inputs
        .filter((input) => resolved.get(input.id)?.source === "explicit")
        .map((input) => input.id),
      defaultedInputIds: params.manifest.setup.inputs
        .filter((input) => resolved.get(input.id)?.source === "default")
        .map((input) => input.id),
      missingOptionalInputIds: params.manifest.setup.inputs
        .filter((input) => !input.required && resolved.get(input.id)?.source === "absent")
        .map((input) => input.id),
      seeds: seedPlans,
      diagnostics,
    },
    ...(diagnostics.length === 0
      ? {
          materialization: {
            schemaDigest,
            answerDigest,
            answers: params.manifest.setup.inputs.flatMap((input) => {
              if (!activeInputIds.has(input.id)) {
                return [];
              }
              const answer = resolved.get(input.id);
              return answer?.value !== undefined && answer.source !== "absent"
                ? [{ id: input.id, value: answer.value, source: answer.source }]
                : [];
            }),
            seeds: renderedSeeds,
          },
        }
      : {}),
  };
}
