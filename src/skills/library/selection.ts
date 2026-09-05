import fs from "node:fs";
import path from "node:path";
import {
  SKILL_LIBRARY_MAX_SELECTIONS,
  type SkillLibrarySelection,
  type SkillsLibraryActivateParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { resolveStateDir } from "../../config/paths.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import {
  parseSkillFrontmatter,
  resolveSkillInvocationPolicy,
  resolveSkillManifestMetadata,
} from "../loading/frontmatter.js";
import { createSyntheticSourceInfo, resolveSkillDisplayName } from "../loading/skill-contract.js";
import type { SkillEntry } from "../types.js";
import { readSkillLibraryManifestTree, skillLibraryRevisionDir } from "./bundle.js";
import { SkillLibraryError } from "./errors.js";
import {
  projectSkillLibraryEntry,
  readSkillLibraryStore,
  requireSkillLibraryEntry,
  resolveSkillLibraryActor,
  selectSkillLibraryRevision,
  skillLibraryDb,
  type SkillLibraryAuthority,
} from "./store.js";
const preparedSelections = new WeakMap<readonly SkillLibrarySelection[], () => void>();

/** Only uncommitted human seeds carry this closure. Persisted session pins intentionally do not. */
export function assertPreparedSkillLibrarySelection(
  selections?: readonly SkillLibrarySelection[],
): void {
  if (selections) {
    preparedSelections.get(selections)?.();
  }
}

const selectedEntryCache = new Map<string, SkillEntry[]>();

/** The session owner has already authorized this exact immutable pin. */
export async function readSelectedSkillLibraryFiles(
  selection: SkillLibrarySelection,
  options: OpenClawStateDatabaseOptions = {},
) {
  const metadata = readSkillLibraryStore(
    (db) => selectSkillLibraryRevision(db, selection.skillId, selection.revision),
    options,
  );
  if (!metadata) {
    throw new SkillLibraryError("NOT_FOUND", "Selected skill revision is unavailable.");
  }
  return await readSkillLibraryManifestTree(
    skillLibraryRevisionDir(selection.skillId, selection.revision, options.env),
    metadata.files_json,
    selection.revision,
  );
}

/** Called only by a fresh human-session admission, never from creator/assignee attribution. */
export function seedSkillLibrarySelection(
  authority: SkillLibraryAuthority,
  options: OpenClawStateDatabaseOptions = {},
): SkillLibrarySelection[] {
  if (!authority.profileId) {
    return [];
  }
  const result =
    readSkillLibraryStore((db) => {
      const actor = resolveSkillLibraryActor(db, authority);
      if (!actor.profileId) {
        return [];
      }
      const entries = executeSqliteQuerySync(
        db,
        skillLibraryDb(db)
          .selectFrom("skill_library_entries")
          .selectAll()
          .where("removed", "=", 0)
          .where("enabled", "=", 1)
          .orderBy("skill_id"),
      ).rows;
      const selections = entries.flatMap((row) => {
        const entry = projectSkillLibraryEntry(db, row, authority);
        if (
          !entry ||
          (entry.ownerProfileId !== actor.profileId &&
            entry.ownerProfileId !== null &&
            !entry.shared)
        ) {
          return [];
        }
        return [
          {
            skillId: entry.skillId,
            revision: entry.revision,
            name: entry.name,
            ownerProfileId: entry.ownerProfileId,
          },
        ];
      });
      // Personal defaults take priority; an overflowing team library never prevents session creation.
      return selections
        .toSorted(
          (a, b) =>
            Number(b.ownerProfileId === actor.profileId) -
            Number(a.ownerProfileId === actor.profileId),
        )
        .slice(0, SKILL_LIBRARY_MAX_SELECTIONS);
    }, options) ?? [];
  if (result.length) {
    preparedSelections.set(result, () => {
      authority.assertCurrent();
      const checked = readSkillLibraryStore((db) => {
        for (const pin of result) {
          const entry = requireSkillLibraryEntry(db, pin.skillId, authority);
          if (
            entry.removed ||
            !entry.enabled ||
            !selectSkillLibraryRevision(db, pin.skillId, pin.revision)
          ) {
            throw new SkillLibraryError(
              "CONFLICT",
              "Default skill access changed during session creation. Retry to select current defaults.",
            );
          }
        }
        return true;
      }, options);
      if (!checked) {
        throw new SkillLibraryError(
          "CONFLICT",
          "Default skill library changed during session creation; retry.",
        );
      }
    });
  }
  return result;
}

/** Session mutation authorization is separate; this checks the collaborator's library access. */
export function changeSkillLibrarySelection(
  authority: SkillLibraryAuthority,
  current: readonly SkillLibrarySelection[],
  params: SkillsLibraryActivateParams,
  options: OpenClawStateDatabaseOptions = {},
): SkillLibrarySelection[] {
  if (params.action !== "refresh" && !params.skillId) {
    throw new SkillLibraryError("INVALID_BUNDLE", "attach/detach requires skillId.");
  }
  if (params.action === "detach") {
    authority.assertCurrent();
    return current.filter((item) => item.skillId !== params.skillId);
  }
  const result = readSkillLibraryStore((db) => {
    const next = new Map(current.map((item) => [item.skillId, item]));
    const ids = params.skillId ? [params.skillId] : current.map((item) => item.skillId);
    for (const skillId of ids) {
      const entry = requireSkillLibraryEntry(db, skillId, authority);
      if (entry.removed) {
        throw new SkillLibraryError(
          "NOT_FOUND",
          "Removed skill cannot be selected. Existing pinned selections remain available.",
        );
      }
      const revision = params.revision ?? entry.revision;
      if (!selectSkillLibraryRevision(db, skillId, revision)) {
        throw new SkillLibraryError("NOT_FOUND", "Skill revision not found.");
      }
      next.set(skillId, {
        skillId,
        revision,
        name: entry.name,
        ownerProfileId: entry.ownerProfileId,
      });
    }
    if (next.size > SKILL_LIBRARY_MAX_SELECTIONS) {
      throw new SkillLibraryError("LIMIT", "A session can select at most 64 library skills.");
    }
    return [...next.values()].toSorted((a, b) =>
      a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0,
    );
  }, options);
  if (!result) {
    throw new SkillLibraryError("NOT_FOUND", "Skill library is empty.");
  }
  return result;
}

/** Resolve already-authorized pins only when rebuilding a snapshot, independent of current sharing. */
export function loadSkillLibrarySelection(
  selections: readonly SkillLibrarySelection[],
  options: OpenClawStateDatabaseOptions = {},
): SkillEntry[] {
  if (!selections.length) {
    return [];
  }
  const cacheKey = JSON.stringify([resolveStateDir(options.env), options.path, selections]);
  const cached = selectedEntryCache.get(cacheKey);
  if (cached) {
    return [...cached];
  }
  if (selections.length > SKILL_LIBRARY_MAX_SELECTIONS) {
    throw new SkillLibraryError("LIMIT", "Invalid session skill selection.");
  }
  const entries = readSkillLibraryStore(
    (db) =>
      selections.map((selection) => {
        const revision = selectSkillLibraryRevision(db, selection.skillId, selection.revision);
        if (!revision) {
          throw new SkillLibraryError(
            "NOT_FOUND",
            "A pinned skill revision is unavailable; restore the library artifact or detach it explicitly.",
          );
        }
        const baseDir = skillLibraryRevisionDir(selection.skillId, selection.revision, options.env);
        const filePath = path.join(baseDir, "SKILL.md");
        const content = fs.readFileSync(filePath, "utf8");
        const frontmatter = parseSkillFrontmatter(content);
        const metadata = resolveSkillManifestMetadata(frontmatter);
        const invocation = resolveSkillInvocationPolicy(frontmatter);
        const name = selection.name;
        return {
          skill: {
            name,
            displayName: resolveSkillDisplayName(content, frontmatter.name ?? name),
            description: revision.description,
            baseDir,
            filePath,
            source: "openclaw-library",
            sourceInfo: createSyntheticSourceInfo(filePath, {
              source: "openclaw-library",
              baseDir,
            }),
            disableModelInvocation: invocation.disableModelInvocation,
          },
          frontmatter,
          invocation,
          // Untrusted frontmatter can constrain executable eligibility, but cannot claim global credentials/config.
          metadata: {
            skillKey: name,
            os: metadata?.os,
            requires: metadata?.requires,
          },
          disableCommandDispatch: true,
          syncSourceDir: baseDir,
          syncDirName: `library-${selection.skillId}-${selection.revision}`,
        } satisfies SkillEntry;
      }),
    options,
  );
  if (!entries) {
    throw new SkillLibraryError(
      "NOT_FOUND",
      "Pinned skill library is unavailable; restore it before running this session.",
    );
  }
  selectedEntryCache.set(cacheKey, entries);
  if (selectedEntryCache.size > 32) {
    selectedEntryCache.delete(selectedEntryCache.keys().next().value!);
  }
  return [...entries];
}
