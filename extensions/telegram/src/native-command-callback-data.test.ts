import { describe, expect, it } from "vitest";
import { parseTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";

describe("parseTelegramNativeCommandCallbackData", () => {
  it("preserves prefixed native commands and rejects malformed command bodies", () => {
    expect(parseTelegramNativeCommandCallbackData("tgcmd:/fast status")).toBe("/fast status");
    expect(parseTelegramNativeCommandCallbackData("tgcmd:/fast auto")).toBe("/fast auto");
    expect(parseTelegramNativeCommandCallbackData("tgcmd:/fast default")).toBe("/fast default");
    expect(parseTelegramNativeCommandCallbackData("tgcmd:fast status")).toBeNull();
  });
});
