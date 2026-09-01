import { randomUUID } from "node:crypto";
import {
  SKILL_LIBRARY_MAX_SELECTIONS,
  validateSkillsLibrarySaveParams,
  type SkillLibraryEntry,
  type SkillsLibraryListParams,
  type SkillsLibraryListResult,
  type SkillsLibrarySaveParams,
  type SkillsLibraryMutateParams,
  type SkillsLibraryReceipt,
  type SkillsLibraryReadResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { evaluateSkillInstallPolicy } from "../../plugins/install-security-scan.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { hasMultipleSessionSharingIdentities } from "../../state/user-profile-list.js";
import {
  assertProposalContainsNoLiteralSecrets,
  scanProposalBundle,
} from "../workshop/proposal-scan.js";
import {
  decodeSkillLibraryFile,
  prepareSkillLibraryBundle,
  readSkillLibraryManifestTree,
  skillLibraryRevisionDir,
  stageSkillLibraryBundle,
} from "./bundle.js";
import { SkillLibraryError } from "./errors.js";
import {
  assertSkillLibraryNameAvailable,
  assertSkillLibraryRevision,
  ensureSkillLibrarySchema,
  projectSkillLibraryEntry,
  readSkillLibraryStore,
  recordSkillLibraryEvent,
  requireSkillLibraryEntry,
  requireSkillLibraryProfile,
  resolveSkillLibraryActor,
  selectSkillLibraryRevision,
  selectSkillLibraryRow,
  skillLibraryDb,
  type SkillLibraryAuthority,
} from "./store.js";

/** Prepared once at human ingress; no library catalog or feature schema work. */
export function resolveSkillLibraryPresentation(
  authority: SkillLibraryAuthority,
  options: OpenClawStateDatabaseOptions = {},
): Pick<
  SkillsLibraryListResult,
  "profileId" | "multipleProfiles" | "defaultTarget" | "canManageWorkspace"
> {
  authority.assertCurrent();
  const multipleProfiles = hasMultipleSessionSharingIdentities(options);
  const actor = resolveSkillLibraryActor(openOpenClawStateDatabase(options).db, authority);
  return {
    profileId: actor.profileId ?? null,
    multipleProfiles,
    defaultTarget:
      actor.profileId && (multipleProfiles || !actor.admin)
        ? "personal"
        : actor.admin
          ? "workspace"
          : "unavailable",
    canManageWorkspace: actor.admin,
  };
}

export function listSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibraryListParams = {},
  options: OpenClawStateDatabaseOptions = {},
): SkillsLibraryListResult {
  authority.assertCurrent();
  const presentation = resolveSkillLibraryPresentation(authority, options);
  const entries =
    readSkillLibraryStore(
      (db) =>
        executeSqliteQuerySync(
          db,
          skillLibraryDb(db)
            .selectFrom("skill_library_entries")
            .selectAll()
            .where("removed", "=", 0)
            .orderBy("slug")
            .orderBy("skill_id"),
        ).rows.flatMap((row) => {
          const entry = projectSkillLibraryEntry(db, row, authority);
          if (
            !entry ||
            (params.scope === "mine" &&
              (!presentation.profileId || entry.ownerProfileId !== presentation.profileId)) ||
            (params.scope === "team" && !entry.shared && entry.ownerProfileId !== null)
          ) {
            return [];
          }
          return [entry];
        }),
      options,
    ) ?? [];
  return {
    entries,
    ...presentation,
    defaultSelectionLimit: SKILL_LIBRARY_MAX_SELECTIONS,
    ...(presentation.profileId &&
    entries.filter(
      (entry) =>
        entry.enabled &&
        (entry.ownerProfileId === presentation.profileId ||
          entry.ownerProfileId === null ||
          entry.shared),
    ).length > SKILL_LIBRARY_MAX_SELECTIONS
      ? {
          defaultSelectionNotice:
            "New sessions select up to 64 enabled skills, personal skills first and then stable ID order. In a session, detach a selected skill to make room and attach another from the library.",
        }
      : {}),
  };
}

export function skillLibraryReceipt(
  entry: SkillLibraryEntry,
  state: SkillsLibraryReceipt["state"] = "published",
): SkillsLibraryReceipt {
  return {
    state,
    target: entry.ownerProfileId === null ? "team" : "personal",
    entry,
    sessionActivation: "new-sessions",
    nextAction:
      state === "removed"
        ? "Existing sessions retain their pinned revision. Create a new skill to add it to future sessions."
        : !entry.enabled
          ? "Disabled for new-session defaults. Existing sessions retain their selected revision; explicit attachment remains available."
          : entry.ownerProfileId !== null && !entry.shared
            ? "Enabled for your new sessions, subject to agent policy and prerequisites. Existing session pins remain. Use skills.library.activate to attach or refresh it."
            : "Enabled for new team sessions, subject to agent policy and prerequisites. Existing session pins remain. Use skills.library.activate to attach or refresh it.",
  };
}

export async function readSkillLibrary(
  authority: SkillLibraryAuthority,
  skillId: string,
  revision?: string,
  options: OpenClawStateDatabaseOptions = {},
  selected?: { revision: string; assertSessionAccess: () => void },
): Promise<SkillsLibraryReadResult> {
  const authorize = (db: import("node:sqlite").DatabaseSync) => {
    if (!selected) {
      return requireSkillLibraryEntry(db, skillId, authority);
    }
    selected.assertSessionAccess();
    if (revision !== selected.revision) {
      throw new SkillLibraryError(
        "FORBIDDEN",
        "Only the session's exact selected revision can be read.",
      );
    }
    const row = selectSkillLibraryRow(db, skillId);
    const entry = row && projectSkillLibraryEntry(db, row, authority, selected.revision, true);
    if (!entry) {
      throw new SkillLibraryError("NOT_FOUND", "Selected revision is unavailable.");
    }
    return { ...entry, canEdit: false };
  };
  const result = readSkillLibraryStore((db) => {
    const entry = authorize(db);
    const selectedRevision = revision ?? entry.revision;
    const metadata = selectSkillLibraryRevision(db, skillId, selectedRevision);
    if (!metadata) {
      throw new SkillLibraryError("NOT_FOUND", "Skill revision not found.");
    }
    return {
      manifestJson: metadata.files_json,
      entry: { ...entry, revision: selectedRevision, description: metadata.description },
      revisions: selected
        ? [{ revision: selected.revision, createdAt: metadata.created_at }]
        : executeSqliteQuerySync(
            db,
            skillLibraryDb(db)
              .selectFrom("skill_library_revisions")
              .select(["revision", "created_at"])
              .where("skill_id", "=", skillId)
              .orderBy("created_at", "desc"),
          ).rows.map((row) => ({ revision: row.revision, createdAt: row.created_at })),
    };
  }, options);
  if (!result) {
    throw new SkillLibraryError("NOT_FOUND", "Skill not found in your accessible library.");
  }
  const files = await readSkillLibraryManifestTree(
    skillLibraryRevisionDir(skillId, result.entry.revision, options.env),
    result.manifestJson,
    result.entry.revision,
  );
  // Revocation or transfer during filesystem work must not return a private artifact.
  if (!readSkillLibraryStore(authorize, options)) {
    throw new SkillLibraryError("NOT_FOUND", "Selected revision is unavailable.");
  }
  return {
    entry: result.entry,
    revisions: result.revisions,
    content: decodeSkillLibraryFile(files.find((file) => file.path === "SKILL.md")!).toString(
      "utf8",
    ),
    files: files.filter((file) => file.path !== "SKILL.md"),
  };
}

export async function saveSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibrarySaveParams,
  options: OpenClawStateDatabaseOptions = {},
  uploadId?: string,
): Promise<SkillsLibraryReceipt> {
  if (!validateSkillsLibrarySaveParams(params)) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Invalid skill save parameters.");
  }
  requireSkillLibraryProfile(openOpenClawStateDatabase(options).db, authority);
  const previous = params.skillId
    ? readSkillLibraryStore(
        (db) => requireSkillLibraryEntry(db, params.skillId!, authority, true),
        options,
      )
    : undefined;
  if (params.skillId && !previous) {
    throw new SkillLibraryError("NOT_FOUND", "Skill not found.");
  }
  if (previous) {
    assertSkillLibraryRevision(previous, params.expectedRevision);
  } else if (params.expectedRevision !== null) {
    throw new SkillLibraryError("CONFLICT", "A new skill requires expectedRevision: null.");
  }
  const bundle = prepareSkillLibraryBundle([
    { path: "SKILL.md", content: params.content },
    ...(params.files ?? []),
  ]);
  const skillId = params.skillId ?? uploadId ?? randomUUID();
  const scan = scanProposalBundle(
    params.content,
    bundle.files
      .filter((file) => file.path !== "SKILL.md")
      .map((file) => ({
        path: file.path,
        content: file.bytes.toString("utf8"),
        sizeBytes: file.sizeBytes,
        hash: file.sha256,
      })),
  );
  assertProposalContainsNoLiteralSecrets(scan);
  if (scan.critical > 0) {
    throw new SkillLibraryError(
      "POLICY_BLOCKED",
      "Skill security scan found critical issues. Review the instructions and support files before publishing.",
    );
  }
  const staged = await stageSkillLibraryBundle(skillId, bundle, options.env);
  try {
    const policy = await evaluateSkillInstallPolicy({
      config: authority.getConfig(),
      installId: "library",
      logger: {},
      origin: { type: "skill-library" },
      source: { kind: "local-path", authority: "user", mutable: false, network: false },
      skillName: params.slug,
      sourceDir: staged.staging,
      mode: previous ? "update" : "install",
    });
    if (policy?.blocked) {
      throw new SkillLibraryError("POLICY_BLOCKED", policy.blocked.reason);
    }
    authority.assertCurrent();
    await staged.publish();
    ensureSkillLibrarySchema(options);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const actor = requireSkillLibraryProfile(db, authority);
        if (uploadId) {
          const upload = executeSqliteQuerySync(
            db,
            skillLibraryDb(db)
              .selectFrom("skill_library_uploads")
              .selectAll()
              .where("upload_id", "=", uploadId),
          ).rows[0];
          if (!upload || upload.slug !== params.slug || upload.expires_at <= Date.now()) {
            throw new SkillLibraryError("NOT_FOUND", "Upload expired; start the import again.");
          }
          if (upload.published_skill_id) {
            return skillLibraryReceipt(
              requireSkillLibraryEntry(db, upload.published_skill_id, authority),
              "unchanged",
            );
          }
        }
        const current = params.skillId
          ? requireSkillLibraryEntry(db, skillId, authority, true)
          : undefined;
        if (current) {
          assertSkillLibraryRevision(current, params.expectedRevision);
        }
        const owner = current ? current.ownerProfileId : actor;
        assertSkillLibraryNameAvailable(db, owner, params.slug, skillId);
        if (current?.revision === bundle.revision && current.slug === params.slug) {
          return skillLibraryReceipt(current, "unchanged");
        }
        const now = Date.now();
        const kysely = skillLibraryDb(db);
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("skill_library_revisions")
            .values({
              skill_id: skillId,
              revision: bundle.revision,
              description: bundle.description,
              files_json: JSON.stringify(bundle.files.map(({ bytes: _bytes, ...file }) => file)),
              created_at: now,
            })
            .onConflict((conflict) => conflict.columns(["skill_id", "revision"]).doNothing()),
        );
        if (current) {
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("skill_library_entries")
              .set({ slug: params.slug, current_revision: bundle.revision, updated_at: now })
              .where("skill_id", "=", skillId),
          );
        } else {
          executeSqliteQuerySync(
            db,
            kysely.insertInto("skill_library_entries").values({
              skill_id: skillId,
              owner_profile_id: actor,
              author_profile_id: actor,
              slug: params.slug,
              current_revision: bundle.revision,
              shared: 0,
              enabled: 1,
              removed: 0,
              created_at: now,
              updated_at: now,
            }),
          );
        }
        recordSkillLibraryEvent(db, skillId, bundle.revision, current ? "save" : "create", actor);
        if (uploadId) {
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("skill_library_uploads")
              .set({ published_skill_id: skillId })
              .where("upload_id", "=", uploadId),
          );
        }
        return skillLibraryReceipt(requireSkillLibraryEntry(db, skillId, authority));
      },
      options,
      { operationLabel: "skills.library.publish" },
    );
  } finally {
    await staged.cleanup();
  }
}

export function mutateSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibraryMutateParams,
  options: OpenClawStateDatabaseOptions = {},
): SkillsLibraryReceipt {
  const exists = readSkillLibraryStore(
    (db) => requireSkillLibraryEntry(db, params.skillId, authority, true),
    options,
  );
  if (!exists) {
    throw new SkillLibraryError("NOT_FOUND", "Skill not found.");
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const actor = requireSkillLibraryProfile(db, authority);
      const current = requireSkillLibraryEntry(db, params.skillId, authority, true);
      assertSkillLibraryRevision(current, params.expectedRevision);
      const changes: {
        shared?: number;
        owner_profile_id?: null;
        enabled?: number;
        removed?: number;
        current_revision?: string;
      } = {};
      switch (params.action) {
        case "share":
        case "unshare":
          if (params.action === "unshare" && current.ownerProfileId === null) {
            throw new SkillLibraryError(
              "FORBIDDEN",
              "Team-owned skills cannot become personal through unshare.",
            );
          }
          changes.shared = Number(params.action === "share");
          break;
        case "transfer":
          if (!resolveSkillLibraryActor(db, authority).admin) {
            throw new SkillLibraryError(
              "FORBIDDEN",
              "Transfer to team ownership requires a Gateway administrator.",
            );
          }
          assertSkillLibraryNameAvailable(db, null, current.slug, current.skillId);
          changes.owner_profile_id = null;
          changes.shared = 1;
          break;
        case "enable":
        case "disable":
          changes.enabled = Number(params.action === "enable");
          break;
        case "remove":
          changes.removed = 1;
          break;
        case "rollback":
          if (
            !params.revision ||
            !selectSkillLibraryRevision(db, current.skillId, params.revision)
          ) {
            throw new SkillLibraryError(
              "NOT_FOUND",
              "Choose a published revision from this skill's history.",
            );
          }
          changes.current_revision = params.revision;
          break;
      }
      executeSqliteQuerySync(
        db,
        skillLibraryDb(db)
          .updateTable("skill_library_entries")
          .set({ ...changes, updated_at: Date.now() })
          .where("skill_id", "=", current.skillId),
      );
      recordSkillLibraryEvent(
        db,
        current.skillId,
        changes.current_revision ?? current.revision,
        params.action,
        actor,
      );
      return skillLibraryReceipt(
        requireSkillLibraryEntry(db, current.skillId, authority),
        params.action === "remove" ? "removed" : "published",
      );
    },
    options,
    { operationLabel: "skills.library.mutate" },
  );
}
