import { describe, expect, it } from "vitest";
import { createCliLocalization } from "./runtime.js";

describe("CLI runtime localization", () => {
  it("resolves the explicit process locale once for one command context", () => {
    const localization = createCliLocalization({
      env: { OPENCLAW_LOCALE: "zh-CN" },
    });

    expect(localization.context.locale).toBe("zh-CN");
    expect(localization.t("cli.update.dryRun.heading")).toBe("更新试运行");
  });

  it("preserves operational parameter values", () => {
    const localization = createCliLocalization({ locale: "zh-CN" });
    const rendered = localization.t("cli.update.dryRun.note.managedRoot", {
      root: "/srv/openclaw",
      previousRoot: "/home/operator/openclaw",
    });

    expect(rendered).toContain("/srv/openclaw");
    expect(rendered).toContain("/home/operator/openclaw");
  });

  it("falls back to reviewed English when the locale has no CLI catalog", () => {
    const localization = createCliLocalization({ locale: "fr" });

    expect(localization.t("cli.update.dryRun.action.plugins")).toBe(
      "Run plugin update sync after core update",
    );
  });

  it("honors the highest-priority POSIX locale instead of falling through", () => {
    const localization = createCliLocalization({
      env: {
        LC_ALL: "fr-FR",
        LC_MESSAGES: "zh_CN.UTF-8",
      },
    });

    expect(localization.context.locale).toBe("en");
    expect(localization.t("cli.update.dryRun.noChanges")).toBe("No changes were applied.");
  });
});
