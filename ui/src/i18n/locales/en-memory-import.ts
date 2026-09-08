import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Memory views register their English fallback when loaded, keeping this copy off startup.
const enMemoryImport = {
  memoryImport: {
    unknownCollection: "Memory collection",
    claudeCode: "Claude Code",
    fileCountOne: "{count} file",
    fileCount: "{count} files",
    alreadyImported: "{count} existing",
    ready: "Ready",
    existing: "Existing",
    importComplete: "Import complete",
    importIncomplete: "Import incomplete",
    importedCount: "{count} files imported",
    importedWithIssues: "{migrated} imported · {errors} failed · {conflicts} conflicts",
    reportSaved: "report saved",
    recoveryFile: "Recovery file",
    recoveryJournal: "Recovery journal",
    itemBackup: "Item backup",
    codexDescription: "Consolidated Codex memory files.",
    claudeDescription: "Claude Code per-project auto-memory files.",
    providerFallback: "Import assistant memory into this agent workspace.",
    reviewFiles: "Review files",
    notFound: "Not found",
    noMemoryFound: "No importable memory found on this computer.",
    source: "Source",
    destination: "Destination",
    selectedCount: "{count} selected",
    selectAtLeastOne: "Select at least one file",
    importSelected: "Import selected",
    confirmTitle: "Import from {provider}?",
    confirmDescription: "Copy {count} selected memory files into this agent workspace.",
    confirmReplace:
      "Existing destination files will be backed up in the migration report before replacement.",
    confirmBackup: "OpenClaw creates a verified pre-import backup before copying memory.",
    confirmImport: "Import memory",
    disconnected: "Connect to the gateway to import memory.",
    adminRequired: "Memory import requires operator.admin access.",
    title: "Import assistant memory",
    subtitle:
      "Review Codex consolidated memory and Claude Code auto-memory before copying it into OpenClaw.",
    agent: "Destination agent",
    replaceExisting: "Replace existing imports",
    replaceHint: "Preview conflicts again and preserve item backups before replacement.",
    backfill: {
      title: "From past sessions",
      subtitle:
        "Stage trusted memories from earlier agent sessions. Dreaming promotes the useful ones into long-term memory.",
      dateRange: "Session date range",
      dateRangeHint: "Leave either date blank to scan the full available range.",
      from: "From",
      to: "To",
      actions: "Backfill",
      preview: "Preview",
      previewing: "Previewing…",
      apply: "Apply",
      applying: "Applying…",
      rollback: "Rollback",
      previewSummary: "{candidates} candidates across {days} days",
      previewTruncated:
        "This preview shows the first bounded batch. Apply continues through the remaining candidates.",
      candidateCount: "{count} candidates",
      noCandidates: "No new trusted session candidates were found.",
      progress: "Processed {days} days · {staged} staged",
      processedCandidates: "{count} session candidates processed",
      processedDayCountOne: "{count} day processed",
      processedDayCount: "{count} days processed",
      complete: "{count} staged; promotion happens via dreaming",
      rollbackConfirmTitle: "Rollback session backfill?",
      rollbackConfirmDescription:
        "Remove diary entries and staged memories created by session backfill for this agent.",
      rollbackWarning:
        "Session backfill cursors are rewound, so the same candidates can be staged again.",
      rollbackComplete: "Session backfill rolled back",
      rollbackCounts: "{diary} diary entries and {staged} staged entries removed",
      unavailable: "Session backfill is unavailable on this Gateway.",
    },
  },
} satisfies TranslationMap;

export const registerMemoryImportEnglish = Object.assign(
  () => {
    en.memoryImport = enMemoryImport.memoryImport;
  },
  { catalog: enMemoryImport },
);
