import type {
  SkillLibraryFile,
  SkillsLibraryReceipt,
  SkillsLibraryReadResult,
  SkillsLibraryActivateResult,
  SkillsLibraryListResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { validateSkillLibraryPath } from "./bundle.js";
import { SkillLibraryError } from "./errors.js";

/** Model edits are named changes; unread binary resources retain their exact bytes and modes. */
export function mergeSkillLibrarySupportFiles(
  current: readonly SkillLibraryFile[],
  upserts: readonly SkillLibraryFile[] = [],
  deletes: readonly string[] = [],
): SkillLibraryFile[] {
  const changed = new Set<string>();
  for (const filePath of [...upserts.map((file) => file.path), ...deletes]) {
    validateSkillLibraryPath(filePath);
    const folded = filePath.toLowerCase();
    if (folded === "skill.md" || changed.has(folded)) {
      throw new SkillLibraryError(
        "INVALID_BUNDLE",
        "Support edits cannot include SKILL.md, duplicate paths, or conflicting upserts and deletes. Use proposal_content for SKILL.md.",
      );
    }
    changed.add(folded);
  }
  const files = new Map(current.map((file) => [file.path, file]));
  for (const filePath of deletes) {
    if (!files.delete(filePath)) {
      throw new SkillLibraryError("INVALID_BUNDLE", `Support file not found: ${filePath}`);
    }
  }
  for (const file of upserts) {
    files.set(file.path, {
      ...file,
      executable: file.executable ?? files.get(file.path)?.executable,
    });
  }
  return [...files.values()];
}

type SkillLibraryAuthoringInput = {
  action:
    | "list"
    | "read"
    | "create"
    | "update"
    | "share"
    | "unshare"
    | "transfer"
    | "activate"
    | "remove"
    | "rollback";
  skillId?: string;
  expectedRevision?: string;
  revision?: string;
  slug?: string;
  content?: string;
  files?: SkillLibraryFile[];
  deleteFiles?: string[];
};
/** Host-held namespace capability; never persisted or reconstructed from session attribution. */
export type SkillLibraryAuthoringCapability = {
  target: "personal";
  defaultTarget: "workspace" | "personal";
  multipleProfiles: boolean;
  assertWorkspaceCurrent?: () => void;
  bind: (context: AdmittedRunContext) => void;
  invoke: (
    params: SkillLibraryAuthoringInput,
  ) => Promise<
    | SkillsLibraryReceipt
    | SkillsLibraryReadResult
    | SkillsLibraryActivateResult
    | SkillsLibraryListResult
  >;
};
