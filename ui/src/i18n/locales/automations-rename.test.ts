// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../../../scripts/lib/control-ui-i18n-config.ts";
import {
  flattenTranslations,
  type TranslationMap,
} from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { en } from "./en.ts";

// Feature-name keys renamed by RFC 0026. Schedule-syntax strings ("Cron
// schedule {expr}", cron expression help) intentionally keep the word cron
// and are excluded: that is syntax terminology, not the feature name.
const RENAMED_FEATURE_KEYS = [
  "sessionsView.showCronSessions",
  "sessionsView.subagentPrefix",
  "sessionsView.automationPrefix",
  "agents.cronPanel.schedulerSubtitle",
  "agents.cronPanel.agentJobsTitle",
  "configForm.sections.cron.label",
  "configView.sections.cron",
  "subtitles.tasks",
  "subtitles.automation",
  "memoryPage.dreaming.intro",
  "tasksPage.runtime.cron",
  "attention.cronFailed",
  "attention.cronOverdue",
  "palette.items.scheduled",
] as const;

describe("automations rename locale catalogs", () => {
  it("renamed English source no longer says cron", () => {
    const flat = flattenTranslations(en, "", new Map());
    for (const key of RENAMED_FEATURE_KEYS) {
      const value = flat.get(key);
      expect(value, key).toBeDefined();
      expect(value, key).not.toMatch(/\bcron\b/i);
    }
  });

  it("no locale overrides a renamed key with stale cron wording", async () => {
    for (const entry of CONTROL_UI_LOCALE_ENTRIES) {
      if (entry.locale === "en") {
        continue;
      }
      const mod = (await import(`./${entry.fileName.replace(/\.ts$/, "")}.ts`)) as Record<
        string,
        TranslationMap
      >;
      const flat = flattenTranslations(mod[entry.exportName] ?? {}, "", new Map());
      for (const key of RENAMED_FEATURE_KEYS) {
        const value = flat.get(key);
        if (value === undefined) {
          continue; // Missing key falls back to corrected English.
        }
        expect(value, `${entry.locale}: ${key}`).not.toMatch(/\bcron\b/i);
      }
    }
  });
});
