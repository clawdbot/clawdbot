import { describe, expect, it } from "vitest";
import {
  buildDiscordActivityCustomId,
  parseDiscordActivityCustomId,
} from "./component-custom-id.js";

describe("Discord Activity custom IDs", () => {
  const widgetId = "AbCdEfGhIjKlMnOpQrSt_-";

  it("round-trips the URL-safe format", () => {
    const customId = buildDiscordActivityCustomId(widgetId);

    expect(customId).toBe(`ocactivity1_${widgetId}`);
    expect(customId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseDiscordActivityCustomId(customId)).toEqual({ widgetId });
  });

  it("keeps parsing the legacy format", () => {
    expect(parseDiscordActivityCustomId(`ocactivity:v=1;wid=${widgetId}`)).toEqual({ widgetId });
  });

  it("rejects malformed and unrelated IDs", () => {
    for (const customId of [
      "",
      "other1_AbCdEfGhIjKlMnOpQrSt_-",
      "ocactivity1_short",
      `ocactivity2_${widgetId}`,
      "ocactivity:v=1;wid=short",
    ]) {
      expect(parseDiscordActivityCustomId(customId)).toBeNull();
    }
  });
});
