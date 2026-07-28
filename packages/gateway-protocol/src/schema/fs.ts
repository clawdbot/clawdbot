import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

// Host directory browsing for the new-session folder picker. Admin-only on the
// gateway; listing stays directories-only so the picker never leaks file names.
export const FsListDirParamsSchema = closedObject({
  /** Absolute directory to list; omitted means the selected host's home directory. */
  path: Type.Optional(NonEmptyString),
  /** Connected node host to browse; omitted means the Gateway host. */
  nodeId: Type.Optional(NonEmptyString),
});

export const FsDirEntrySchema = closedObject({
  name: NonEmptyString,
  path: NonEmptyString,
  /** Dot-prefixed directories; clients render them dimmed after visible ones. */
  hidden: Type.Optional(Type.Boolean()),
});

export const FsListDirResultSchema = closedObject({
  /** Resolved absolute path that was listed. */
  path: NonEmptyString,
  /** Absent at the filesystem root. */
  parent: Type.Optional(NonEmptyString),
  /** Selected host's home directory, for the picker's "home" shortcut. */
  home: NonEmptyString,
  entries: Type.Array(FsDirEntrySchema),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type FsDirEntry = Static<typeof FsDirEntrySchema>;
export type FsListDirParams = Static<typeof FsListDirParamsSchema>;
export type FsListDirResult = Static<typeof FsListDirResultSchema>;
