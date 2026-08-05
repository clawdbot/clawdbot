import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerDiscordComponentEntries,
  resolveDiscordComponentEntryWithPersistence,
  resolveDiscordModalEntryWithPersistence,
} from "../components-registry.js";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import type { ButtonInteraction, ComponentData } from "../internal/discord.js";
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
      const showModal = vi.fn().mockRejectedValue(new Error("Discord rejected the modal"));
      const reply = replyRejects
        ? vi.fn().mockRejectedValue(new Error("Discord rejected the recovery reply"))
        : vi.fn().mockResolvedValue(undefined);
      const interaction = {
        rawData: { channel_id: "dm-channel", id: "interaction-1" },
        customId: "occomp:cid=btn_1",
        client: {
          rest: {
            get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
            post: vi.fn().mockResolvedValue({}),
            patch: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue(undefined),
          },
        },
        user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
        message: { id: "msg-1" },
        defer: vi.fn().mockResolvedValue(undefined),
        showModal,
        reply,
      } as unknown as ButtonInteraction;

      await button.run(interaction, { cid: "btn_1", mid: "mdl_1" } as ComponentData);

      expect(showModal).toHaveBeenCalledOnce();
      expect(reply).toHaveBeenCalledOnce();
      expect(reply).toHaveBeenCalledWith({
        content: "Could not open this form. Request a new form and try again.",
        ephemeral: true,
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
