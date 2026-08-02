// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../../scripts/lib/control-ui-i18n-config.ts";
import {
  flattenTranslations,
  type TranslationMap,
} from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { en } from "./locales/en.ts";

// Feature-name keys renamed by RFC 0026. Schedule-syntax strings ("Cron
// schedule {expr}", cron expression help) intentionally keep the word cron
// and are excluded: that is syntax terminology, not the feature name.
//
// Non-English catalogs are generated: CI forbids committing translation memory
// alongside source changes, and the post-merge control-ui-locale-refresh
// workflow retranslates renamed keys from this English source. These
// assertions therefore pin the English source of truth; the workflow-owned
// catalogs inherit them on refresh.
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

  it("typed-session prefixes are catalog keys in every locale that carries them", async () => {
    for (const entry of CONTROL_UI_LOCALE_ENTRIES) {
      if (entry.locale === "en") {
        continue;
      }
      const mod = (await import(`./locales/${entry.fileName.replace(/\.ts$/, "")}.ts`)) as Record<
        string,
        TranslationMap
      >;
      const flat = flattenTranslations(mod[entry.exportName] ?? {}, "", new Map());
      for (const key of ["sessionsView.subagentPrefix", "sessionsView.automationPrefix"]) {
        const value = flat.get(key);
        if (value === undefined) {
          continue; // Not yet refreshed; falls back to the English catalog value.
        }
        expect(value, `${entry.locale}: ${key}`).not.toMatch(/\bcron\b/i);
      }
    }
  });
});
