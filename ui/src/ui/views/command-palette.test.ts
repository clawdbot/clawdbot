import { afterEach, describe, expect, it } from "vitest";
import { refreshSlashCommands, resetSlashCommandsForTest } from "../chat/slash-commands.ts";
import { getPaletteItems } from "./command-palette.ts";

afterEach(() => {
  resetSlashCommandsForTest();
});

describe("command palette", () => {
  it("builds slash items from the live runtime command list", async () => {
    const request = async (method: string) => {
      expect(method).toBe("commands.list");
      return {
        commands: [
          {
            name: "pair",
            textAliases: ["/pair"],
            description: "Generate setup codes and approve device pairing requests.",
            source: "plugin",
            scope: "both",
            acceptsArgs: true,
          },
          {
            name: "prose",
            textAliases: ["/prose"],
            description: "Draft polished prose.",
            source: "skill",
            scope: "both",
            acceptsArgs: true,
          },
        ],
      };
    };

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });

    const items = getPaletteItems();
    expect(items).toContainEqual(
      expect.objectContaining({
        id: "slash:pair",
        label: "/pair",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        id: "slash:prose",
        label: "/prose",
      }),
    );
  });
});
