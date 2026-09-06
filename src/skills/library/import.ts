import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  validateSkillsLibraryUploadParams,
  type SkillsLibraryUploadParams,
  type SkillsLibraryUploadResult,
  type SkillsLibraryImportParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withTempWorkspace } from "../../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { installSkillFromClawHub } from "../lifecycle/clawhub.js";
import {
  prepareSkillLibraryBundle,
  readSkillLibraryTree,
  SKILL_LIBRARY_MAX_PATH_COMPONENTS,
  SKILL_LIBRARY_MAX_TREE_ENTRIES,
} from "./bundle.js";
import { SkillLibraryError } from "./errors.js";
import { saveSkillLibrary, skillLibraryReceipt } from "./service.js";
import {
  ensureSkillLibrarySchema,
  requireSkillLibraryEntry,
  requireSkillLibraryProfile,
  requireSkillLibraryUpload,
  requireSkillLibraryUploadMetadata,
  selectSkillLibraryOwner,
  skillLibraryDb,
  type SkillLibraryAuthority,
} from "./store.js";

const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_ACTIVE_UPLOADS = 32;

async function publishDirectory(
  authority: SkillLibraryAuthority,
  slug: string,
  directory: string,
  options: OpenClawStateDatabaseOptions,
  uploadId?: string,
) {
  const files = await readSkillLibraryTree(directory);
  prepareSkillLibraryBundle(files);
  const markdown = files.find((file) => file.path === "SKILL.md")!;
  return saveSkillLibrary(
    authority,
    {
      slug,
      expectedRevision: null,
      content: Buffer.from(markdown.content, "base64").toString("utf8"),
      files: files.filter(
        (file) => file !== markdown && !/^\.(?:clawhub|clawdhub)\//u.test(file.path),
      ),
    },
    options,
    uploadId,
  );
}

/** Imports through the existing source policy/verification flow into private temporary artifacts. */
export async function importSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibraryImportParams,
  options: OpenClawStateDatabaseOptions = {},
) {
  requireSkillLibraryProfile(openOpenClawStateDatabase(options).db, authority);
  return withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-library-source-" },
    async ({ dir }) => {
      const installed = await installSkillFromClawHub({
        workspaceDir: dir,
        slug: params.source.slug,
        version: params.source.version,
        config: authority.getConfig(),
      });
      authority.assertCurrent();
      if (!installed.ok) {
        throw new SkillLibraryError("POLICY_BLOCKED", installed.error);
      }
      return publishDirectory(authority, params.slug, installed.targetDir, options);
    },
  );
}

/** Upload bytes never enter the admin upload store; every stage resolves the durable profile anew. */
export async function uploadSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibraryUploadParams,
  options: OpenClawStateDatabaseOptions = {},
): Promise<SkillsLibraryUploadResult> {
  if (!validateSkillsLibraryUploadParams(params)) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Invalid library upload parameters.");
  }
  requireSkillLibraryProfile(openOpenClawStateDatabase(options).db, authority);
  ensureSkillLibrarySchema(options);
  if (params.action === "begin") {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const actor = requireSkillLibraryProfile(db, authority);
      const kysely = skillLibraryDb(db);
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("skill_library_uploads").where("expires_at", "<=", Date.now()),
      );
      // Completed receipts remain replayable without occupying an active upload slot.
      const activeUploads = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("skill_library_uploads")
          .select("owner_profile_id")
          .where("published_skill_id", "is", null)
          .limit(MAX_ACTIVE_UPLOADS),
      ).rows;
      // One canonical profile may fill only half the pool, including uploads begun before a merge.
      if (
        activeUploads.length >= MAX_ACTIVE_UPLOADS ||
        activeUploads.filter(
          (upload) => selectSkillLibraryOwner(db, upload.owner_profile_id)?.id === actor,
        ).length >=
          MAX_ACTIVE_UPLOADS / 2
      ) {
        throw new SkillLibraryError(
          "LIMIT",
          "Active import limit reached for your profile or the Gateway. Finish an existing import or retry after it expires.",
        );
      }
      const uploadId = randomUUID();
      executeSqliteQuerySync(
        db,
        kysely.insertInto("skill_library_uploads").values({
          upload_id: uploadId,
          owner_profile_id: actor,
          slug: params.slug,
          size_bytes: params.sizeBytes,
          sha256: params.sha256,
          archive_blob: Buffer.alloc(0),
          expires_at: Date.now() + 3_600_000,
          published_skill_id: null,
        }),
      );
      return { uploadId, offset: 0, maxChunkBytes: MAX_CHUNK_BYTES };
    }, options);
  }
  const readOwned = () =>
    requireSkillLibraryUpload(openOpenClawStateDatabase(options).db, params.uploadId, authority);
  if (params.action === "chunk") {
    const bytes = Buffer.from(params.data, "base64");
    if (
      !bytes.length ||
      bytes.length > MAX_CHUNK_BYTES ||
      bytes.toString("base64") !== params.data
    ) {
      throw new SkillLibraryError(
        "INVALID_BUNDLE",
        "Invalid upload chunk; send canonical base64, at most 256 KiB decoded.",
      );
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const upload = readOwned();
      const current = Buffer.from(upload.archive_blob);
      if (
        upload.published_skill_id ||
        params.offset !== current.length ||
        current.length + bytes.length > upload.size_bytes
      ) {
        throw new SkillLibraryError(
          "CONFLICT",
          "Upload offset changed or upload completed. Start a new import.",
        );
      }
      const next = Buffer.concat([current, bytes]);
      executeSqliteQuerySync(
        db,
        skillLibraryDb(db)
          .updateTable("skill_library_uploads")
          .set({ archive_blob: next })
          .where("upload_id", "=", params.uploadId),
      );
      return { uploadId: params.uploadId, offset: next.length, maxChunkBytes: MAX_CHUNK_BYTES };
    }, options);
  }
  const upload = readOwned();
  if (upload.published_skill_id) {
    return skillLibraryReceipt(
      requireSkillLibraryEntry(
        openOpenClawStateDatabase(options).db,
        upload.published_skill_id,
        authority,
      ),
      "unchanged",
    );
  }
  const bytes = Buffer.from(upload.archive_blob);
  if (
    bytes.length !== upload.size_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== upload.sha256
  ) {
    throw new SkillLibraryError(
      "INVALID_BUNDLE",
      "Upload is incomplete or its SHA-256 does not match.",
    );
  }
  return withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-library-import-" },
    async ({ dir }) => {
      const archivePath = path.join(dir, "skill.zip");
      await fs.writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" });
      const result = await withExtractedArchiveRoot({
        archivePath,
        tempDirPrefix: "openclaw-library-extract-",
        timeoutMs: 120_000,
        rootMarkers: ["SKILL.md"],
        limits: {
          maxArchiveBytes: SKILL_LIBRARY_MAX_BUNDLE_BYTES,
          maxExtractedBytes: SKILL_LIBRARY_MAX_BUNDLE_BYTES,
          maxEntryBytes: SKILL_LIBRARY_MAX_FILE_BYTES,
          // Packed roots may have one wrapper directory outside the library tree.
          maxEntries: SKILL_LIBRARY_MAX_TREE_ENTRIES + 1,
          maxEntryPathComponents: SKILL_LIBRARY_MAX_PATH_COMPONENTS + 1,
        },
        onExtracted: async (rootDir) => ({
          ok: true as const,
          receipt: await publishDirectory(
            {
              ...authority,
              assertCurrent: () =>
                requireSkillLibraryUploadMetadata(
                  openOpenClawStateDatabase(options).db,
                  params.uploadId,
                  authority,
                ),
            },
            upload.slug,
            rootDir,
            options,
            upload.upload_id,
          ),
        }),
      });
      if (!result.ok) {
        throw new SkillLibraryError("INVALID_BUNDLE", result.error);
      }
      return result.receipt;
    },
  );
}
