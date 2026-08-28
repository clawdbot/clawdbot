import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiscordComponentCustomId } from "../component-custom-id.js";
import {
  registerDiscordComponentEntries,
  resolveDiscordComponentEntryWithPersistence,
  resolveDiscordModalEntryWithPersistence,
} from "../components-registry.js";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import { ButtonInteraction, createInteraction, type ComponentData } from "../internal/discord.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { resetDiscordComponentRuntimeMocks } from "../test-support/component-runtime.js";
import { createDiscordComponentControls } from "./agent-components.js";

describe("Discord modal presentation failures", () => {
  beforeEach(() => {
    clearDiscordComponentEntriesForTest();
    resetDiscordComponentRuntimeMocks();
  });

  it.each([{ replyRejects: false }, { replyRejects: true }])(
    "handles a rejected modal callback with replyRejects=$replyRejects",
    async ({ replyRejects }) => {
      const sharedComponent = {
        messageId: "msg-1",
        sessionKey: "session-1",
        agentId: "agent-1",
        accountId: "default",
        consumptionGroupId: "group-1",
        consumptionGroupEntryIds: ["btn_1", "btn_cancel"],
      };
      const modalTrigger: DiscordComponentEntry = {
        ...sharedComponent,
        id: "btn_1",
        kind: "modal-trigger",
        label: "Open form",
        modalId: "mdl_1",
      };
      const siblingButton: DiscordComponentEntry = {
        ...sharedComponent,
        id: "btn_cancel",
        kind: "button",
        label: "Cancel",
      };
      const modal: DiscordModalEntry = {
        id: "mdl_1",
        title: "Details",
        messageId: "msg-1",
        sessionKey: "session-1",
        agentId: "agent-1",
        accountId: "default",
        fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
      };
      registerDiscordComponentEntries({ entries: [modalTrigger, siblingButton], modals: [modal] });

      const createButton = createDiscordComponentControls[0];
      if (!createButton) {
        throw new Error("expected Discord component button factory");
      }
      const cfg: OpenClawConfig = {
        channels: { discord: { replyToMode: "first" } },
      };
      const button = createButton({
        cfg,
        accountId: "default",
        dmPolicy: "allowlist",
        allowFrom: ["123456789"],
        discordConfig: { replyToMode: "first" },
        token: "token",
      });
      const post = vi.fn().mockRejectedValueOnce(new Error("Discord rejected the modal"));
      if (replyRejects) {
        post.mockRejectedValueOnce(new Error("Discord rejected the recovery reply"));
      } else {
        post.mockResolvedValueOnce(undefined);
      }
      const client = createInternalTestClient();
      attachRestMock(client, { post });
      const interaction = createInteraction(
        client,
        createInternalComponentInteractionPayload({
          id: "interaction-1",
          token: "interaction-token",
          channel_id: "dm-channel",
          user: {
            id: "123456789",
            username: "AgentUser",
            discriminator: "0001",
            global_name: null,
            avatar: null,
          },
          data: {
            custom_id: buildDiscordComponentCustomId({ componentId: "btn_1", modalId: "mdl_1" }),
          },
        }),
      );
      if (!(interaction instanceof ButtonInteraction)) {
        throw new Error("expected a Discord button interaction");
      }

      await button.run(interaction, { cid: "btn_1", mid: "mdl_1" } as ComponentData);

      const callbackPath = "/interactions/interaction-1/interaction-token/callback";
      expect(post).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenNthCalledWith(
        1,
        callbackPath,
        expect.objectContaining({
          body: expect.objectContaining({ type: InteractionResponseType.Modal }),
        }),
      );
      expect(post).toHaveBeenNthCalledWith(2, callbackPath, {
        body: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: "Could not open this form. Request a new form and try again.",
            flags: MessageFlags.Ephemeral,
          },
        },
      });
      await expect(
        resolveDiscordComponentEntryWithPersistence({ id: "btn_1", consume: false }),
      ).resolves.toBeNull();
      await expect(
        resolveDiscordComponentEntryWithPersistence({ id: "btn_cancel", consume: false }),
      ).resolves.toBeNull();
      await expect(
        resolveDiscordModalEntryWithPersistence({ id: "mdl_1", consume: false }),
      ).resolves.toEqual(expect.objectContaining({ id: "mdl_1" }));
    },
  );
});
