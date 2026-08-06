// Control UI i18n script tests cover locale extraction and validation.
import { describe, expect, it } from "vitest";
import {
  findPlaceholderMismatches,
  isProviderAuthError,
  resolveTranslationModel,
} from "../../scripts/control-ui-i18n.ts";

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

describe("control-ui-i18n translation runtime resolution", () => {
  it("uses the in-tree OpenClaw LLM model catalog", () => {
    expect(resolveTranslationModel()).toMatchObject({
      id: "gpt-5.6-sol",
      provider: "openai",
    });
  });
});

describe("control-ui-i18n provider auth errors", () => {
  it("recognizes OpenAI and Anthropic authentication failures", () => {
    expect(isProviderAuthError(new Error("401 Incorrect API key provided"))).toBe(true);
    expect(
      isProviderAuthError(
        new Error(
          '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        ),
      ),
    ).toBe(true);
    expect(isProviderAuthError(new Error("model timed out"))).toBe(false);
  });
});
