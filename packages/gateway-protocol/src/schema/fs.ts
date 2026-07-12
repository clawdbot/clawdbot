import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

// Host directory browsing for the new-session folder picker. Admin-only on the
// gateway; listing stays directories-only so the picker never leaks file names.
export const FsListDirParamsSchema = Type.Object(
  {
    /** Absolute directory to list; omitted means the gateway host home directory. */
    path: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const FsDirEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    /** Dot-prefixed directories; clients render them dimmed after visible ones. */
    hidden: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const FsListDirResultSchema = Type.Object(
  {
    /** Resolved absolute path that was listed. */
    path: NonEmptyString,
    /** Absent at the filesystem root. */
    parent: Type.Optional(NonEmptyString),
    /** Gateway host home directory, for the picker's "home" shortcut. */
    home: NonEmptyString,
    entries: Type.Array(FsDirEntrySchema),
  },
  { additionalProperties: false },
);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type FsDirEntry = Static<typeof FsDirEntrySchema>;
export type FsListDirParams = Static<typeof FsListDirParamsSchema>;
export type FsListDirResult = Static<typeof FsListDirResultSchema>;
