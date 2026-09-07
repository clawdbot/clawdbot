import { expect, it } from "vitest";
import { workboardTestHost } from "../test/host.setup.ts";
import { t } from "./index.ts";

it("uses the host locale for migrated Workboard translations", () => {
  Object.assign(workboardTestHost().host, { locale: "zh-CN" });
  expect(t("workboard.widget.boardLabel")).toBe("Workboard 看板");
  expect(t("workboard.widget.cardCount", { count: "3" })).toBe("3 张卡片");
});

it("falls back to English for an untranslated locale", () => {
  Object.assign(workboardTestHost().host, { locale: "unsupported-locale" });
  expect(t("workboard.newCard")).toBe("New card");
});
