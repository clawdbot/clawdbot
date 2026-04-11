import { describe, expect, it } from "vitest";
import { extractSimpleExplicitGroupId } from "./group-id-simple.js";

describe("extractSimpleExplicitGroupId", () => {
  it("returns undefined for empty/null input", () => {
    expect(extractSimpleExplicitGroupId(undefined)).toBeUndefined();
    expect(extractSimpleExplicitGroupId(null)).toBeUndefined();
    expect(extractSimpleExplicitGroupId("")).toBeUndefined();
    expect(extractSimpleExplicitGroupId("  ")).toBeUndefined();
  });

  it("extracts group ID from telegram group format", () => {
    expect(extractSimpleExplicitGroupId("telegram:group:-1003776849159")).toBe("-1003776849159");
  });

  it("extracts group ID from telegram forum topic format, stripping topic suffix", () => {
    expect(extractSimpleExplicitGroupId("telegram:group:-1003776849159:topic:1264")).toBe(
      "-1003776849159",
    );
  });

  it("extracts group ID from channel format", () => {
    expect(extractSimpleExplicitGroupId("telegram:channel:-1001234567890")).toBe("-1001234567890");
  });

  it("extracts group ID from channel format with topic", () => {
    expect(extractSimpleExplicitGroupId("telegram:channel:-1001234567890:topic:42")).toBe(
      "-1001234567890",
    );
  });

  it("extracts group ID from bare group: prefix", () => {
    expect(extractSimpleExplicitGroupId("group:-1003776849159")).toBe("-1003776849159");
  });

  it("extracts group ID from bare group: prefix with topic", () => {
    expect(extractSimpleExplicitGroupId("group:-1003776849159:topic:999")).toBe("-1003776849159");
  });

  it("extracts WhatsApp group ID", () => {
    expect(extractSimpleExplicitGroupId("whatsapp:120363123456789@g.us")).toBe(
      "120363123456789@g.us",
    );
  });

  it("returns undefined for unrecognized formats", () => {
    expect(extractSimpleExplicitGroupId("user:12345")).toBeUndefined();
    expect(extractSimpleExplicitGroupId("just-a-string")).toBeUndefined();
  });
});
