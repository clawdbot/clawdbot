// Telegram tests cover command ui plugin behavior.
import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
} from "openclaw/plugin-sdk/command-status";
import { createPluginCommandRuntime } from "openclaw/plugin-sdk/plugin-command-runtime";
import { matchPluginCommand, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it } from "vitest";
import { buildPluginTelegramMenuCommands } from "./bot-native-command-menu.js";
import { buildCommandsPaginationKeyboard } from "./command-ui.js";
import { inputRichBlocksToPlainText } from "./rich-block-model.js";
import { planTelegramTextDeliveryPages } from "./telegram-text-delivery.js";

function registerCommand(name: string, nativeNames?: Record<string, string>) {
  expect(
    registerPluginCommand(name, {
      name,
      description: `Run ${name}`,
      acceptsArgs: true,
      nativeNames,
      handler: async () => ({ text: name }),
    }),
  ).toEqual({ ok: true });
}

function commandPages() {
  const first = buildCommandsMessagePaginated(undefined, undefined, { forcePaginatedList: true });
  return Array.from({ length: first.totalPages }, (_, index) =>
    buildCommandsMessagePaginated(undefined, undefined, {
      forcePaginatedList: true,
      page: index + 1,
    }),
  );
}

describe("telegram command ui", () => {
  it("adds agent id to command pagination callback data when provided", () => {
    const keyboard = buildCommandsPaginationKeyboard(2, 3, "agent-main");
    expect(keyboard[0]).toEqual([
      { text: "◀ Prev", callback_data: "commands_page_1:agent-main" },
      { text: "2/3", callback_data: "commands_page_noop:agent-main" },
      { text: "Next ▶", callback_data: "commands_page_3:agent-main" },
    ]);
  });

  it.each([false, true])(
    "preserves command owners when normalized names collide (reverse=%s)",
    (reverse) => {
      withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
        const names = reverse ? ["foo_bar", "foo-bar"] : ["foo-bar", "foo_bar"];
        for (const name of names) {
          registerCommand(name);
        }
        const plainList = buildCommandsMessage();
        const paginatedList = commandPages()
          .map((page) => page.text)
          .join("\n");
        for (const text of [plainList, paginatedList]) {
          expect(text).toContain("`/foo-bar` (foo-bar) - Run foo-bar");
          expect(text).toContain("/foo_bar (foo_bar) - Run foo_bar");
        }
        expect(matchPluginCommand("/foo-bar status")?.command.name).toBe("foo-bar");
        expect(matchPluginCommand("/foo_bar status")?.command.name).toBe("foo_bar");
        const catalog = buildPluginTelegramMenuCommands({
          specs: createPluginCommandRuntime().listNativeCandidates("telegram"),
          existingCommands: new Set(),
        });
        expect(catalog.commands).toEqual([{ command: "foo_bar", description: "Run foo_bar" }]);
      });
    },
  );

  it("preserves explicit native aliases without relabeling canonical text commands", () => {
    withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
      registerCommand("foo-bar", { telegram: "other_name" });
      registerCommand("foo_bar");
      expect(buildCommandsMessage()).toContain("`/foo-bar` (foo-bar)");
      expect(matchPluginCommand("/foo-bar status")?.command.name).toBe("foo-bar");
      expect(matchPluginCommand("/other_name status", { channel: "telegram" })?.command.name).toBe(
        "foo-bar",
      );
      const catalog = buildPluginTelegramMenuCommands({
        specs: createPluginCommandRuntime().listNativeCandidates("telegram"),
        existingCommands: new Set(),
      });
      expect(catalog.commands).toEqual([
        { command: "foo_bar", description: "Run foo_bar" },
        { command: "other_name", description: "Run foo-bar" },
      ]);
    });
  });

  it.each([false, true])(
    "encodes registered command names as code in initial delivery (rich=%s)",
    (richMessages) => {
      withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
        registerCommand("active-memory");
        const page = commandPages().find((entry) => entry.text.includes("active-memory"));
        if (!page) {
          throw new Error("registered command was not listed");
        }
        const deliveries = planTelegramTextDeliveryPages({
          text: page.text,
          maxChars: 4096,
          richMessages,
        });
        if (richMessages) {
          const blocks = deliveries.flatMap((delivery) => delivery.richMessage?.blocks ?? []);
          expect(inputRichBlocksToPlainText(blocks)).toContain("/active-memory");
          expect(blocks).toContainEqual(
            expect.objectContaining({
              type: "paragraph",
              text: expect.arrayContaining([
                expect.objectContaining({ type: "code", text: "/active-memory" }),
              ]),
            }),
          );
        } else {
          expect(deliveries.map((delivery) => delivery.htmlText).join("\n")).toContain(
            "<code>/active-memory</code>",
          );
        }
      });
    },
  );
});
