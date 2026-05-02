// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type SlashCommandsModule = typeof import("./slash-commands.js");
const browserImportPath: string = "./slash-commands.ts?browser-import";

describe("slash command browser import", () => {
  it("builds fallback commands from the browser-safe shared registry", async () => {
    const mod = (await import(browserImportPath)) as SlashCommandsModule;

    expect(mod.SLASH_COMMANDS.find((command) => command.name === "think")).toMatchObject({
      name: "think",
      category: "model",
    });
  });

  it("keeps provider thinking runtime out of the Control UI import path", async () => {
    const slashCommands = await readFile(new URL("./slash-commands.ts", import.meta.url), "utf8");
    const sharedRegistry = await readFile(
      new URL("../../../../src/auto-reply/commands-registry.shared.ts", import.meta.url),
      "utf8",
    );
    const serverRegistry = await readFile(
      new URL("../../../../src/auto-reply/commands-registry.data.ts", import.meta.url),
      "utf8",
    );
    const mod = (await import(browserImportPath)) as SlashCommandsModule;

    expect(mod.SLASH_COMMANDS.some((command) => command.name === "think")).toBe(true);
    expect(slashCommands).toContain("commands-registry.shared.js");
    expect(sharedRegistry).toContain("thinking.shared.js");
    expect(sharedRegistry).not.toContain("./thinking.js");
    expect(sharedRegistry).not.toContain("provider-thinking");
    expect(serverRegistry).toContain('from "./thinking.js"');
  });
});
