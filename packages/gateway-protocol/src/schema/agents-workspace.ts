// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Read-only agent workspace browsing schemas.
 *
 * These contracts back the workspace file browser in operator clients
 * (mobile apps, Control UI). The surface is intentionally read-only:
 * write/delete/upload stay out of this namespace until a separately
 * reviewed mutation contract exists.
 */

/** One file or folder in an agent workspace directory listing. */
export const AgentsWorkspaceEntrySchema = closedObject({
  path: NonEmptyString,
  name: NonEmptyString,
  kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
  size: Type.Optional(Type.Integer({ minimum: 0 })),
  updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Lists one directory of an agent workspace. */
export const AgentsWorkspaceListParamsSchema = closedObject({
  agentId: NonEmptyString,
  path: Type.Optional(Type.String()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

/** Paginated directory listing rooted at the agent workspace. */
export const AgentsWorkspaceListResultSchema = closedObject({
  agentId: NonEmptyString,
  path: Type.String(),
  parentPath: Type.Optional(Type.String()),
  entries: Type.Array(AgentsWorkspaceEntrySchema),
  totalEntries: Type.Integer({ minimum: 0 }),
  offset: Type.Integer({ minimum: 0 }),
});

/** One workspace file preview payload (UTF-8 text or base64 image). */
export const AgentsWorkspaceFileSchema = closedObject({
  path: NonEmptyString,
  name: NonEmptyString,
  size: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  mimeType: NonEmptyString,
  encoding: Type.Union([Type.Literal("utf8"), Type.Literal("base64")]),
  content: Type.String(),
});

/** Reads one workspace file by workspace-relative path. */
export const AgentsWorkspaceGetParamsSchema = closedObject({
  agentId: NonEmptyString,
  path: NonEmptyString,
});

/** Result for reading one workspace file. */
export const AgentsWorkspaceGetResultSchema = closedObject({
  agentId: NonEmptyString,
  file: AgentsWorkspaceFileSchema,
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type AgentsWorkspaceEntry = Static<typeof AgentsWorkspaceEntrySchema>;
export type AgentsWorkspaceFile = Static<typeof AgentsWorkspaceFileSchema>;
export type AgentsWorkspaceListParams = Static<typeof AgentsWorkspaceListParamsSchema>;
export type AgentsWorkspaceListResult = Static<typeof AgentsWorkspaceListResultSchema>;
export type AgentsWorkspaceGetParams = Static<typeof AgentsWorkspaceGetParamsSchema>;
export type AgentsWorkspaceGetResult = Static<typeof AgentsWorkspaceGetResultSchema>;
