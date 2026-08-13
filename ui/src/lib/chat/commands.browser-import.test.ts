// @vitest-environment node
import { describe, expect, it } from "vitest";

type CommandsModule = typeof import("./commands.js");
const browserImportPath = "./commands.ts?browser-import";

describe("slash command browser import", () => {
  it("builds fallback commands from the browser-safe shared registry", async () => {
    const mod = (await import(browserImportPath)) as CommandsModule;

    const thinkCommand = mod.SLASH_COMMANDS.find((command) => command.name === "think");
    expect(thinkCommand).toEqual({
      key: "think",
      name: "think",
      aliases: ["thinking", "t"],
      description: "Set thinking level.",
      category: "model",
      args: "[level]",
      icon: "brain",
      executeLocal: true,
      argOptions: undefined,
      tier: "essential",
      source: "native",
    });
  });
});
