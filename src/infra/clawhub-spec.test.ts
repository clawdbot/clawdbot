// Verifies parsing of explicit ClawHub plugin specs.
import { describe, expect, it } from "vitest";
import { parseClawHubPluginSpec } from "./clawhub-spec.js";

describe("clawhub plugin specs", () => {
  it("parses explicit ClawHub package specs", () => {
    expect(parseClawHubPluginSpec("clawhub:demo")).toEqual({
      name: "demo",
    });
    expect(parseClawHubPluginSpec("clawhub:demo@1.2.3")).toEqual({
      name: "demo",
      version: "1.2.3",
    });
    expect(parseClawHubPluginSpec("clawhub:@scope/pkg")).toEqual({
      name: "@scope/pkg",
    });
    expect(parseClawHubPluginSpec("clawhub:@scope/pkg@1.2.3")).toEqual({
      name: "@scope/pkg",
      version: "1.2.3",
    });
    expect(parseClawHubPluginSpec("clawhub:demo@")).toBeNull();
    expect(parseClawHubPluginSpec("clawhub:@scope/pkg@")).toBeNull();
    expect(parseClawHubPluginSpec("@scope/pkg")).toBeNull();
  });
});
