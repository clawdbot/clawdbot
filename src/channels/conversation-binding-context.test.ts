import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveConversationBindingContext } from "./conversation-binding-context.js";

describe("resolveConversationBindingContext", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("uses the plugin default account when accountId is omitted", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "line",
              label: "LINE",
              config: {
                listAccountIds: () => ["default", "work"],
                defaultAccountId: () => "work",
              },
            }),
            bindings: {
              resolveCommandConversation: ({
                originatingTo,
                commandTo,
                fallbackTo,
              }: {
                originatingTo?: string;
                commandTo?: string;
                fallbackTo?: string;
              }) => {
                const conversationId = [originatingTo, commandTo, fallbackTo]
                  .map((candidate) => candidate?.trim().replace(/^line:/i, ""))
                  .map((candidate) => candidate?.replace(/^user:/i, ""))
                  .find((candidate) => candidate && candidate.length > 0);
                return conversationId ? { conversationId } : null;
              },
            },
          },
        },
      ]),
    );

    expect(
      resolveConversationBindingContext({
        cfg: {} as OpenClawConfig,
        channel: "line",
        originatingTo: "line:user:U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      channel: "line",
      accountId: "work",
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
  });

  it("normalizes provider-resolved conversation ids before returning binding context", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "line",
              label: "LINE",
            }),
            bindings: {
              resolveCommandConversation: () => ({
                conversationId: "  user:U1234567890abcdef1234567890abcdef  ",
                parentConversationId: "  room:R1234567890abcdef1234567890abcd  ",
              }),
            },
          },
        },
      ]),
    );

    expect(
      resolveConversationBindingContext({
        cfg: {} as OpenClawConfig,
        channel: "line",
        accountId: " default ",
        originatingTo: "ignored",
      }),
    ).toEqual({
      channel: "line",
      accountId: "default",
      conversationId: "user:U1234567890abcdef1234567890abcdef",
      parentConversationId: "room:R1234567890abcdef1234567890abcd",
    });
  });

  it("normalizes focused binding conversation ids before returning binding context", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "line",
              label: "LINE",
            }),
            threading: {
              resolveFocusedBinding: () => ({
                conversationId: "  user:U99999999999999999999999999999999  ",
                parentConversationId: "  room:R999999999999999999999999999999  ",
              }),
            },
          },
        },
      ]),
    );

    expect(
      resolveConversationBindingContext({
        cfg: {} as OpenClawConfig,
        channel: "line",
        accountId: " default ",
        originatingTo: "ignored",
      }),
    ).toEqual({
      channel: "line",
      accountId: "default",
      conversationId: "user:U99999999999999999999999999999999",
      parentConversationId: "room:R999999999999999999999999999999",
    });
  });
});
