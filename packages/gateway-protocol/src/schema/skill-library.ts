import type { Static } from "typebox";
import { Type } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import {
  SKILL_LIBRARY_MAX_FILES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
} from "./skill-library-constants.js";

export {
  SKILL_LIBRARY_MAX_FILES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_SELECTIONS,
} from "./skill-library-constants.js";
const id = Type.String({ pattern: "^[a-f0-9-]{36}$" });
const revision = Type.String({ pattern: "^[a-f0-9]{64}$" });
const slug = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" });
const sessionKey = Type.String({ minLength: 1, maxLength: 512 });
const closed = { additionalProperties: false } as const;

export const SkillLibraryFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    content: Type.String({ maxLength: Math.ceil(SKILL_LIBRARY_MAX_FILE_BYTES / 3) * 4 }),
    encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
    executable: Type.Optional(Type.Boolean()),
  },
  closed,
);
export const SkillLibrarySelectionSchema = Type.Object(
  {
    skillId: id,
    revision,
    /** Persisted command identity: library collisions never shadow workspace names. */
    name: Type.String({ minLength: 1, maxLength: 128 }),
    ownerProfileId: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
  },
  closed,
);
export const SkillsLibraryListParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(sessionKey),
    scope: Type.Optional(
      Type.Union([Type.Literal("mine"), Type.Literal("team"), Type.Literal("all")]),
    ),
  },
  closed,
);
export const SkillsLibraryReadParamsSchema = Type.Object(
  { skillId: id, revision: Type.Optional(revision), sessionKey: Type.Optional(sessionKey) },
  closed,
);
export const SkillsLibrarySaveParamsSchema = Type.Object(
  {
    skillId: Type.Optional(id),
    expectedRevision: Type.Union([revision, Type.Null()]),
    slug,
    content: Type.String({ minLength: 1, maxLength: SKILL_LIBRARY_MAX_FILE_BYTES }),
    files: Type.Optional(
      Type.Array(SkillLibraryFileSchema, { maxItems: SKILL_LIBRARY_MAX_FILES - 1 }),
    ),
  },
  closed,
);
export const SkillsLibraryMutateParamsSchema = Type.Object(
  {
    skillId: id,
    expectedRevision: revision,
    action: Type.Union([
      Type.Literal("share"),
      Type.Literal("unshare"),
      Type.Literal("transfer"),
      Type.Literal("remove"),
      Type.Literal("enable"),
      Type.Literal("disable"),
      Type.Literal("rollback"),
    ]),
    revision: Type.Optional(revision),
  },
  closed,
);
export const SkillsLibraryActivateParamsSchema = Type.Object(
  {
    sessionKey,
    action: Type.Union([Type.Literal("attach"), Type.Literal("detach"), Type.Literal("refresh")]),
    skillId: Type.Optional(id),
    revision: Type.Optional(revision),
  },
  closed,
);
export const SkillsLibraryImportParamsSchema = Type.Object(
  {
    slug,
    source: Type.Object(
      {
        kind: Type.Literal("clawhub"),
        slug: Type.String({ minLength: 1, maxLength: 256 }),
        version: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      },
      closed,
    ),
  },
  closed,
);
export const SkillsLibraryUploadParamsSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("begin"),
      slug,
      sizeBytes: Type.Integer({ minimum: 1, maximum: SKILL_LIBRARY_MAX_BUNDLE_BYTES }),
      sha256: revision,
    },
    closed,
  ),
  Type.Object(
    {
      action: Type.Literal("chunk"),
      uploadId: id,
      offset: Type.Integer({ minimum: 0 }),
      data: Type.String({ maxLength: 350000 }),
    },
    closed,
  ),
  Type.Object({ action: Type.Literal("commit"), uploadId: id }, closed),
]);

export type SkillLibraryFile = Static<typeof SkillLibraryFileSchema>;
export type SkillLibrarySelection = Static<typeof SkillLibrarySelectionSchema>;
export type SkillsLibraryListParams = Static<typeof SkillsLibraryListParamsSchema>;
export type SkillsLibraryReadParams = Static<typeof SkillsLibraryReadParamsSchema>;
export type SkillsLibrarySaveParams = Static<typeof SkillsLibrarySaveParamsSchema>;
export type SkillsLibraryMutateParams = Static<typeof SkillsLibraryMutateParamsSchema>;
export type SkillsLibraryActivateParams = Static<typeof SkillsLibraryActivateParamsSchema>;
export type SkillsLibraryImportParams = Static<typeof SkillsLibraryImportParamsSchema>;
export type SkillsLibraryUploadParams = Static<typeof SkillsLibraryUploadParamsSchema>;

export type SkillLibraryEntry = {
  skillId: string;
  slug: string;
  name: string;
  description: string;
  ownerProfileId: string | null;
  ownerLabel: string;
  authorProfileId: string;
  shared: boolean;
  enabled: boolean;
  removed: boolean;
  revision: string;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
};
export type SkillsLibraryListResult = {
  entries: SkillLibraryEntry[];
  profileId: string | null;
  multipleProfiles: boolean;
  defaultTarget: "workspace" | "personal" | "unavailable";
  canManageWorkspace: boolean;
  defaultSelectionLimit: number;
  defaultSelectionNotice?: string;
  session?: {
    sessionKey: string;
    selections: Array<
      SkillLibrarySelection & { slug: string; description: string; ownerLabel: string }
    >;
    attachable: SkillLibraryEntry[];
  };
};
export type SkillsLibraryReadResult = {
  entry: SkillLibraryEntry;
  content: string;
  files: SkillLibraryFile[];
  revisions: Array<{ revision: string; createdAt: number }>;
};
export type SkillsLibraryReceipt = {
  state: "published" | "unchanged" | "removed";
  target: "personal" | "team";
  entry: SkillLibraryEntry;
  sessionActivation: "new-sessions";
  nextAction: string;
};
export type SkillsLibraryActivateResult = {
  sessionKey: string;
  selections: SkillLibrarySelection[];
  sessionActivation: "next-turn";
};
export type SkillsLibraryUploadResult =
  | { uploadId: string; offset: number; maxChunkBytes: number }
  | SkillsLibraryReceipt;

export const validateSkillsLibraryListParams = lazyCompile(SkillsLibraryListParamsSchema);
export const validateSkillsLibraryReadParams = lazyCompile(SkillsLibraryReadParamsSchema);
export const validateSkillsLibrarySaveParams = lazyCompile(SkillsLibrarySaveParamsSchema);
export const validateSkillsLibraryMutateParams = lazyCompile(SkillsLibraryMutateParamsSchema);
export const validateSkillsLibraryActivateParams = lazyCompile(SkillsLibraryActivateParamsSchema);
export const validateSkillsLibraryImportParams = lazyCompile(SkillsLibraryImportParamsSchema);
export const validateSkillsLibraryUploadParams = lazyCompile(SkillsLibraryUploadParamsSchema);
