import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { SETTINGS_SEARCH_TARGETS } from "../pages/config/settings-targets.ts";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { en } from "./locales/en.ts";

// Other UI files can register lazy catalogs in the shared worker. Start this
// loading contract from an untouched module graph, as a new browser does.
vi.hoisted(() => vi.resetModules());

const startupCapture = structuredClone(expectDefined(en.meetingCapture, "eager capture labels"));
const startupTranscripts = en.transcripts;
let restoreI18n: () => Promise<void>;

beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});

afterEach(async () => {
  en.meetingCapture = structuredClone(startupCapture);
  if (startupTranscripts === undefined) {
    delete en.transcripts;
  } else {
    en.transcripts = startupTranscripts;
  }
  await restoreI18n();
});

afterAll(async () => {
  // Cached surfaces must retain the catalog they registered for later shared-worker tests.
  const { registerTranscriptsEnglish } = await import("./locales/en-transcripts.ts");
  registerTranscriptsEnglish();
});

describe("transcript English loading", () => {
  it.each([
    { surface: "library", load: () => import("../pages/meetings/view.ts") },
    { surface: "settings", load: () => import("../pages/config/meeting-capture.ts") },
  ])("keeps startup labels and loads complete fallback copy from $surface", async ({ load }) => {
    const manager = createI18nManagerForTesting(async () => ({ common: { health: "Gesundheit" } }));
    const capture = SETTINGS_SEARCH_TARGETS.meetingCapture;
    expect(manager.t(capture.labelKey)).toBe("Meeting capture");
    expect(capture.searchKeys.map((key) => manager.t(key))).toEqual([
      "Choose which sources can save meeting notes on this Gateway.",
      "Auto-start sources",
    ]);
    expect(manager.t("tabs.meetings")).toBe("Meetings");
    expect(manager.t("transcripts.summaryHint")).toBe("transcripts.summaryHint");
    expect(manager.t("meetingCapture.sourceChanged")).toBe("meetingCapture.sourceChanged");

    await manager.setLocale("de");
    await load();
    const { registerTranscriptsEnglish } = await import("./locales/en-transcripts.ts");
    for (const [key, value] of flattenTranslations(registerTranscriptsEnglish.catalog)) {
      expect(manager.t(key)).toBe(value);
    }
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(manager.t("transcripts.summaryHint")).toBe(
      "Check the transcript before relying on decisions or action items.",
    );
    expect(manager.t("meetingCapture.sourceChanged")).toBe(
      "This source changed while you were editing. Cancel and reopen it to use the current draft.",
    );
    expect(manager.t("transcripts.savedCount", { count: "154" })).toBe("154 saved utterances");
    expect(manager.t(capture.labelKey)).toBe("Meeting capture");
  });
});
