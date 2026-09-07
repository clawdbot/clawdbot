import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { en } from "./locales/en.ts";

// Start from a cold catalog rather than a preceding shared-worker chat import.
vi.hoisted(() => vi.resetModules());

let restoreI18n: () => Promise<void>;
beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});
afterEach(async () => {
  await restoreI18n();
});
afterAll(async () => {
  const { registerBookmarksEnglish } = await import("./locales/en-bookmarks.ts");
  registerBookmarksEnglish();
});

it("keeps the shared title eager and resolves lazy bookmark fallback without replacing its namespace", async () => {
  const manager = createI18nManagerForTesting(async () => ({ common: { health: "Gesundheit" } }));
  const namespace = en.chat.bookmarks;
  expect(manager.t("chat.bookmarks.title")).toBe("Bookmarks");
  expect(manager.t("chat.bookmarks.storageUnavailable")).toBe("chat.bookmarks.storageUnavailable");
  await manager.setLocale("de");
  await import("../pages/chat/chat-bookmarks.ts");
  const { registerBookmarksEnglish } = await import("./locales/en-bookmarks.ts");
  expect(en.chat.bookmarks).toBe(namespace);
  expect(manager.t("chat.bookmarks.title")).toBe("Bookmarks");
  for (const [key, value] of flattenTranslations(registerBookmarksEnglish.catalog)) {
    expect(manager.t(key)).toBe(value);
  }
  expect(manager.t("common.health")).toBe("Gesundheit");
  registerBookmarksEnglish();
  expect(en.chat.bookmarks).toBe(namespace);
});
