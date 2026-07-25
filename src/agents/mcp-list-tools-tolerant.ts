/** Tolerant `tools/list` result parsing for schemas the MCP SDK rejects outright. */
import { z } from "zod";

// The SDK's ToolSchema requires `inputSchema.type` to be the literal "object", so
// a server that describes its object argument some other legal way -- a root-level
// `oneOf`/`anyOf`/`allOf` of objects, ordinary in JSON Schema 2020-12 -- fails
// client-side result validation and takes every other tool on that server down with
// it. We relax that ONE requirement, but only for schemas that still PROVABLY
// describe an object: a stated non-object type, or an untyped schema with no object
// evidence (so it could permit an array/string/any), stays rejected -- preserving
// the MCP contract that tool arguments are objects.

/** True when `schema` provably describes an object argument (see the note above). */
function describesObjectArguments(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return false;
  }
  const s = schema as Record<string, unknown>;
  if (s.type === "object") {
    return true;
  }
  if (typeof s.type === "string") {
    return false; // a stated non-object type is not a tool argument object
  }
  if (Array.isArray(s.type)) {
    return s.type.length > 0 && s.type.every((entry) => entry === "object");
  }
  if ("properties" in s || "required" in s || "additionalProperties" in s) {
    return true;
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = s[key];
    if (
      Array.isArray(branches) &&
      branches.length > 0 &&
      branches.every(describesObjectArguments)
    ) {
      return true;
    }
  }
  return false;
}

const ObjectArgumentJsonSchema = z.custom<Record<string, unknown>>(describesObjectArguments);

const RelaxedToolSchema = z.looseObject({
  name: z.string(),
  inputSchema: ObjectArgumentJsonSchema.optional(),
  outputSchema: ObjectArgumentJsonSchema.optional(),
});

export const RelaxedListToolsResultSchema = z.looseObject({
  tools: z.array(RelaxedToolSchema),
  nextCursor: z.string().optional(),
});

type ListToolsParams = { cursor?: string } | undefined;
type ListToolsRequestOptions = { timeout?: number; signal?: AbortSignal } | undefined;

type ListToolsRequester = (
  request: { method: "tools/list"; params: ListToolsParams },
  resultSchema: typeof RelaxedListToolsResultSchema,
  options: ListToolsRequestOptions,
) => Promise<unknown>;

type ListToolsCapableClient<TPage> = {
  listTools(params?: { cursor?: string }, options?: { timeout?: number; signal?: AbortSignal }): Promise<TPage>;
};

/**
 * True when the sole complaint about the response is the declared type of a tool
 * schema -- `tools[n].inputSchema.type` or `tools[n].outputSchema.type`. Anything
 * else (a transport error, a missing name, a schema that is not an object at all)
 * is a real failure and keeps its existing handling, retry-free.
 */
function isToolSchemaTypeOnlyFailure(error: unknown): boolean {
  const issues = (error as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return false;
  }
  return issues.every((issue) => {
    const path = (issue as { path?: unknown })?.path;
    return (
      Array.isArray(path) &&
      path.length === 4 &&
      path[0] === "tools" &&
      (path[2] === "inputSchema" || path[2] === "outputSchema") &&
      path[3] === "type"
    );
  });
}

/**
 * Lists one page of tools through the SDK client, retrying with a relaxed result
 * schema when -- and only when -- a tool schema's declared type is the single thing
 * the SDK objected to. Conforming servers stay on the SDK path untouched, including
 * its output-schema caching; the retry costs one extra request on a page that has
 * already failed, and is skipped for clients that cannot issue a raw request.
 */
export async function listToolsTolerant<TPage>(
  client: ListToolsCapableClient<TPage>,
  params?: { cursor?: string },
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<TPage> {
  try {
    return await client.listTools(params, options);
  } catch (error) {
    const request = (client as { request?: unknown }).request;
    if (!isToolSchemaTypeOnlyFailure(error) || typeof request !== "function") {
      throw error;
    }
    try {
      return (await (request as ListToolsRequester).call(
        client,
        { method: "tools/list", params },
        RelaxedListToolsResultSchema,
        options,
      )) as TPage;
    } catch {
      // The relaxed schema rejected it too, so the response is malformed beyond a
      // missing root type. Report the original failure -- it is the precise one.
      throw error;
    }
  }
}
