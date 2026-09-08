import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { z } from "zod";
import {
  SessionFileEntrySchema,
  SessionsDiffResultSchema,
  SessionsFilesGetResultSchema,
  SessionsFilesListResultSchema,
} from "../../packages/gateway-protocol/src/schema/sessions.js";

export const WORKSPACE_INSPECTION_COMMAND = "openclaw-internal-workspace-inspect";
export const WORKSPACE_INSPECTION_MAX_BYTES = 2 * 1024 * 1024;

export function isWorkspaceInspectionCommand(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === WORKSPACE_INSPECTION_COMMAND;
}

const text = z.string().min(1).max(4096);
const files = z.array(z.object({ path: text, kind: z.enum(["read", "modified"]) }).strict());
const owner = { sessionKey: text };
const schema = z.discriminatedUnion("operation", [
  z
    .object({
      ...owner,
      operation: z.literal("list"),
      path: z.string().optional(),
      search: z.string().optional(),
      files,
    })
    .strict(),
  z.object({ ...owner, operation: z.literal("get"), path: text, files }).strict(),
  z
    .object({
      ...owner,
      operation: z.literal("set"),
      path: text,
      content: z.string(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
  z
    .object({
      ...owner,
      operation: z.literal("diff"),
      scope: z.enum(["all", "uncommitted", "commit"]),
      commit: text.optional(),
      baseCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
    })
    .strict(),
]);

export type WorkspaceInspectionInput = z.infer<typeof schema>;

export function parseWorkspaceInspectionInput(input: string | undefined): WorkspaceInspectionInput {
  if (!input || Buffer.byteLength(input) > WORKSPACE_INSPECTION_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: workspace inspection input exceeds its bound");
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("INVALID_REQUEST: workspace inspection input is not valid JSON");
  }
  const checked = schema.safeParse(value);
  if (!checked.success) {
    throw new Error("INVALID_REQUEST: workspace inspection input is invalid");
  }
  const parsed = checked.data;
  if (
    parsed.operation === "diff" &&
    (parsed.scope === "commit") !== (parsed.commit !== undefined)
  ) {
    throw new Error("INVALID_REQUEST: commit is required only for commit inspection");
  }
  return parsed;
}

const writeResult = Type.Union([
  Type.Object(
    { status: Type.Literal("updated"), root: Type.String(), file: SessionFileEntrySchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal("conflict"), currentHash: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
    { additionalProperties: false },
  ),
  Type.Object({ status: Type.Literal("unsafe") }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal("missing") }, { additionalProperties: false }),
  Type.Object(
    { status: Type.Literal("too-large"), size: Type.Integer({ minimum: 0 }) },
    { additionalProperties: false },
  ),
]);
const resultSchemas = {
  list: Type.Omit(SessionsFilesListResultSchema, ["sessionKey"]),
  get: Type.Partial(Type.Omit(SessionsFilesGetResultSchema, ["sessionKey"])),
  set: writeResult,
  diff: SessionsDiffResultSchema,
};

export type WorkspaceInspectionResult<T extends WorkspaceInspectionInput["operation"]> = Static<
  (typeof resultSchemas)[T]
>;

export function parseWorkspaceInspectionResult<T extends WorkspaceInspectionInput["operation"]>(
  operation: T,
  raw: string,
): WorkspaceInspectionResult<T> {
  if (Buffer.byteLength(raw) > WORKSPACE_INSPECTION_MAX_BYTES) {
    throw new Error("Workspace inspection result exceeds its bound");
  }
  const value: unknown = JSON.parse(raw);
  if (!Value.Check(resultSchemas[operation], value)) {
    throw new Error("Workspace inspection returned an invalid result");
  }
  return value;
}
