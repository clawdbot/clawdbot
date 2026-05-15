import { describe, expect, it } from "vitest";
import {
  filterRawCopyEntries,
  filterTranslationKeysBySurface,
  formatReport,
  parseArgs,
  summarizeRawCopy,
  type RawCopyBaselineEntry,
} from "../../scripts/control-ui-i18n-report.ts";

const entries: RawCopyBaselineEntry[] = [
  {
    count: 2,
    kind: "html-text",
    name: "text",
    path: "ui/src/ui/chat/render.ts",
    text: "Send",
  },
  {
    count: 1,
    kind: "object-property",
    name: "label",
    path: "ui/src/ui/views/agents-panels-tools.ts",
    text: "Tools",
  },
  {
    count: 4,
    kind: "html-attribute",
    name: "title",
    path: "ui/src/ui/views/config-form.render.ts",
    text: "Open config",
  },
];

describe("control-ui-i18n report helpers", () => {
  it("rejects invalid numeric limits", () => {
    expect(() => parseArgs(["--top", "3abc"])).toThrow("--top must be a positive integer");
    expect(() => parseArgs(["--top", "1.5"])).toThrow("--top must be a positive integer");
    expect(() => parseArgs(["--top", "0"])).toThrow("--top must be a positive integer");
    expect(() => parseArgs(["--top", "999999999999999999999999999"])).toThrow(
      "--top must be a positive integer",
    );
  });

  it("rejects locale path traversal before filesystem access", () => {
    expect(parseArgs(["--locale", "zh-CN"])).toMatchObject({ locale: "zh-CN" });
    expect(() => parseArgs(["--locale", "../zh-CN"])).toThrow("unknown locale");
    expect(() => parseArgs(["--locale", "../../../../scripts/control-ui-i18n-report"])).toThrow(
      "unknown locale",
    );
  });

  it("filters raw-copy entries by path surface token", () => {
    expect(filterRawCopyEntries(entries, "agents")).toEqual([entries[1]]);
    expect(filterRawCopyEntries(entries, "config")).toEqual([entries[2]]);
    expect(filterRawCopyEntries(entries, "missing")).toEqual([]);
  });

  it("summarizes raw-copy occurrences deterministically", () => {
    expect(summarizeRawCopy(entries, 2)).toEqual({
      entries: 3,
      occurrences: 7,
      topPaths: [
        { count: 4, path: "ui/src/ui/views/config-form.render.ts" },
        { count: 2, path: "ui/src/ui/chat/render.ts" },
      ],
    });
  });

  it("filters translation keys by surface token", () => {
    expect(
      filterTranslationKeysBySurface(
        [
          "agents.tabs.cronJobs",
          "chat.composer.send",
          "sessionsView.thinking",
          "usage.common.emptyValue",
        ],
        "chat",
      ),
    ).toEqual(["chat.composer.send"]);
    expect(
      filterTranslationKeysBySurface(
        [
          "agents.tabs.cronJobs",
          "chat.composer.send",
          "sessionsView.thinking",
          "usage.common.emptyValue",
        ],
        "sessions",
      ),
    ).toEqual(["sessionsView.thinking"]);
  });

  it("formats pasteable report text", () => {
    const report = formatReport({
      locale: {
        fallbackKeysInScope: ["actions.cancel"],
        meta: {
          fallbackKeys: ["actions.cancel"],
          generatedAt: "2026-05-13T00:00:00.000Z",
          locale: "zh-CN",
          model: "gpt-5.5",
          provider: "openai",
          sourceHash: "hash",
          totalKeys: 3,
          translatedKeys: 2,
          workflow: 1,
        },
      },
      rawCopy: summarizeRawCopy(entries, 1),
      surface: "chat",
    });

    expect(report).toContain("Control UI i18n baseline report\n");
    expect(report).toContain("Scope: Chat, Simplified Chinese (zh-CN)\n");
    expect(report).toContain(
      "Based on: current raw-copy baseline and locale metadata. Not a drift check.\n",
    );
    expect(report).toContain(
      "Hardcoded UI text outside i18n: 3 pieces in code, 7 total occurrences.\n",
    );
    expect(report).toContain(
      "Existing zh-CN translation keys (all Control UI): 2/3 filled, 1 fallback.\n",
    );
    expect(report).toContain("Chat still has UI text written directly in code.\n");
    expect(report).toContain("zh-CN has 1 missing key.\n");
    expect(report).not.toContain("matches English");
    expect(report).toContain("4 Config form: ui/src/ui/views/config-form.render.ts\n");
    expect(report).toContain("Move text from the focus modules into translation keys.\n");
    expect(report).toContain(
      "Do not hand-edit generated locale, translation memory, or i18n metadata files.\n",
    );
    expect(report).toContain("Run pnpm ui:i18n:sync after adding translation keys.\n");
    expect(report).not.toContain("raw-copy entries");
  });

  it("keeps fallback-key issues scoped to the selected surface", () => {
    const report = formatReport({
      locale: {
        fallbackKeysInScope: [],
        meta: {
          fallbackKeys: ["usage.common.emptyValue"],
          generatedAt: "2026-05-13T00:00:00.000Z",
          locale: "zh-CN",
          model: "gpt-5.5",
          provider: "openai",
          sourceHash: "hash",
          totalKeys: 3,
          translatedKeys: 2,
          workflow: 1,
        },
      },
      rawCopy: summarizeRawCopy(entries, 1),
      surface: "chat",
    });

    expect(report).toContain(
      "Existing zh-CN translation keys (all Control UI): 2/3 filled, 1 fallback.\n",
    );
    expect(report).toContain("No zh-CN locale problems found in this scope.\n");
    expect(report).not.toContain("zh-CN has 1 missing key.\n");
  });
});
