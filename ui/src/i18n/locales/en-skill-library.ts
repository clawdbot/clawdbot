import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Register library copy with the lazy Skills and chat surfaces, keeping it out
// of the Control UI startup catalog.
const enSkillLibrary = {
  skillLibrary: {
    library: "Skill library",
    mine: "My skills",
    team: "Team",
    all: "All libraries",
    inventory: "Agent & workspace",
    create: "Create skill",
    import: "Import skill",
    save: "Save skill",
    propose: "Save workspace proposal",
    apply: "Apply to workspace",
    slug: "Skill name",
    slugHelp: "Use 1–63 lowercase letters, digits, or hyphens; start with a letter or digit.",
    description: "Description",
    file: "File",
    newFile: "New text file path",
    addFile: "Add file",
    deleteFile: "Delete file",
    deleteFileConfirm: "Remove {path} from the next saved bundle?",
    fileExists: "That file already exists. Select it to edit its contents.",
    binary: "Binary attachment. Its original bytes are preserved when you save.",
    binaryRead: "Binary attachment retained with this revision.",
    readOnly: "You can read this skill. Only its owner or an authorized administrator can edit it.",
    personalTarget:
      "My skills. Save to your personal library; existing session selections change only when you explicitly attach or refresh.",
    workspaceTarget: "Workspace: {agent}. Save creates a Workshop proposal; apply it after review.",
    technicalDetails: "Skill details",
    skillId: "Skill ID",
    command: "Command",
    ownerRevision: "{owner} · revision {revision}",
    executable: "Executable supporting file",
    defaultLimit:
      "New sessions select up to {count} default skills. Existing sessions keep their selected revisions.",
    session: {
      selected: "Selected for this session",
      attachable: "Add from your libraries",
      pin: "Selected revision {revision}",
      read: "Read selected revision",
      empty: "No managed skills selected.",
      refresh: "Refresh revision",
      attachNamed: "Attach {name} · {owner}",
      detach: "Detach",
      queued:
        "Skill selections updated for the next turn. An active turn keeps its current revision.",
      readOnly:
        "This is the exact revision selected for this session. Session access allows reading this pin, not editing its library or browsing other revisions.",
    },
    search: "Search names, descriptions, and owners",
    empty: "No skills in this library. Create one or import a bundle.",
    you: "You",
    shared: "Shared with team",
    private: "Private",
    share: "Share with team",
    unshare: "Make private",
    transfer: "Transfer to team",
    remove: "Remove skill",
    enable: "Enable",
    disable: "Disable",
    revision: "Retained revision",
    selectRevision: "Select a revision",
    rollback: "Restore revision",
    discard: "Discard your unsaved skill changes?",
    conflict:
      "This skill changed since you opened it. Your draft is preserved. Copy your changes, then close and reopen the skill to review the current revision before saving.",
    signIn:
      "Sign in with a Gateway profile to create personal skills. Administrators can still create skills in the selected agent workspace.",
    connectionChanged: "The Gateway connection changed. Reopen the skill before saving.",
    selectAgent: "Select an agent workspace before creating a skill.",
    workspaceTextOnly:
      "Workshop imports support UTF-8 text files. Keep executable and binary assets in the file-authored workspace workflow.",
    bundleLimit: "Use at most 256 files, 1 MiB per file, and 8 MiB per bundle or ZIP.",
    missingSkill:
      "Choose SKILL.md together with its supporting files, or a folder containing SKILL.md at its root.",
    uploadFailed:
      "The Gateway did not confirm the upload. Check your library before retrying the import.",
    pending:
      "Proposal {id} saved for workspace {agent}. It is pending review and is not active yet.",
    workspaceSaved: "Workspace {agent}: {state}. Start a new session to use the skill.",
    importHelp:
      "Import SKILL.md with supporting files, a local folder, or a ZIP into your private library. Text bundles open for review before saving; ZIP imports publish when you choose Import skill.",
    importWorkspace:
      "Choose SKILL.md and supporting text files or a folder. Review the content, then save and apply a Workshop proposal to the selected agent workspace. Use ClawHub below for workspace installs.",
    importClawHub:
      "Import {source} into your private library. This does not publish your files or install host dependencies.",
    chooseFiles: "SKILL.md, supporting files, or ZIP",
    chooseFolder: "Skill folder",
    confirm: {
      remove: "Remove {slug} from the library?",
      transfer: "Transfer {slug} to team ownership? Team administrators will manage it.",
    },
    receipt: {
      published: "Saved {slug} to {target} library (owner: {owner}).",
      unchanged: "Unchanged: {slug} in {target} library (owner: {owner}).",
      removed: "Removed {slug} from {target} library (owner: {owner}).",
    },
  },
} satisfies TranslationMap;

export const registerSkillLibraryEnglish = Object.assign(
  () => {
    en.skillLibrary = enSkillLibrary.skillLibrary;
  },
  { catalog: enSkillLibrary },
);
