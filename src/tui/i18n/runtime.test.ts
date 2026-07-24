import { describe, expect, it } from "vitest";
import { createTuiLocalization } from "./runtime.js";

describe("TUI status localization", () => {
  it("resolves one immutable explicit localization context", () => {
    const localization = createTuiLocalization({ locale: "zh-CN" });

    expect(Object.isFrozen(localization)).toBe(true);
    expect(Object.isFrozen(localization.context)).toBe(true);
    expect(localization.context.locale).toBe("zh-CN");
    expect(localization.t("tui.status.heading")).toBe("网关状态");
  });

  it("preserves literal paths and model identifiers", () => {
    const localization = createTuiLocalization({ locale: "zh-CN" });

    expect(localization.t("tui.status.sessionStore", { path: "/srv/openclaw/sessions" })).toContain(
      "/srv/openclaw/sessions",
    );
    expect(
      localization.t("tui.status.defaultModel", {
        model: "provider/model-id",
        context: "（64k 上下文）",
      }),
    ).toContain("provider/model-id");
  });

  it("falls back to reviewed English for locales without a TUI catalog", () => {
    const localization = createTuiLocalization({ locale: "fr" });

    expect(localization.t("tui.status.activeSessions", { count: 2 })).toBe("Active sessions: 2");
  });

  it("does not bypass an unsupported higher-priority process locale", () => {
    const localization = createTuiLocalization({
      env: { LC_ALL: "fr-FR", LC_MESSAGES: "zh_CN.UTF-8" },
    });

    expect(localization.context.locale).toBe("en");
    expect(localization.t("tui.status.linked")).toBe("linked");
  });
});
