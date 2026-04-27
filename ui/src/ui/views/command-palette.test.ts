import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { refreshSlashCommands, resetSlashCommandsForTest } from "../chat/slash-commands.ts";
import { getFilteredPaletteItems, getPaletteItems } from "./command-palette.ts";

afterEach(async () => {
  resetSlashCommandsForTest();
  await i18n.setLocale("en");
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

  it("matches localized base item labels and descriptions", async () => {
    await i18n.setLocale("zh-CN");

    expect(getPaletteItems()).toContainEqual(
      expect.objectContaining({
        id: "nav-config",
        label: "设置",
      }),
    );
    expect(getFilteredPaletteItems("切换调试")).toContainEqual(
      expect.objectContaining({
        id: "skill-debug",
      }),
    );
  });
});
