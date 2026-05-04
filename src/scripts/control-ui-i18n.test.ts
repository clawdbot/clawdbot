import { describe, expect, it } from "vitest";
import { findPlaceholderMismatches } from "../../scripts/control-ui-i18n.ts";

describe("control-ui-i18n placeholder validation", () => {
  it("reports missing and extra placeholders by key", () => {
    const mismatches = findPlaceholderMismatches(
      new Map([
        ["sessionsView.activeTooltip", "Updated in the last {count} minutes."],
        ["sessionsView.store", "Store: {path}"],
        ["sessionsView.limitTooltip", "Max sessions to load."],
      ]),
      new Map([
        ["sessionsView.activeTooltip", "Actualizadas en los últimos N minutos."],
        ["sessionsView.store", "Almacén: {path}"],
        ["sessionsView.limitTooltip", "Máximo {extra} de sesiones."],
      ]),
      "es",
    );

    expect(mismatches).toEqual([
      {
        key: "sessionsView.activeTooltip",
        locale: "es",
        sourcePlaceholders: ["count"],
        translatedPlaceholders: [],
      },
      {
        key: "sessionsView.limitTooltip",
        locale: "es",
        sourcePlaceholders: [],
        translatedPlaceholders: ["extra"],
      },
    ]);
  });
});
