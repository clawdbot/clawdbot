import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiscordComponentCustomId } from "../component-custom-id.js";
import {
  registerDiscordComponentEntries,
  resolveDiscordComponentEntryWithPersistence,
  resolveDiscordModalEntryWithPersistence,
} from "../components-registry.js";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import { ButtonInteraction, createInteraction, type ComponentData } from "../internal/discord.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import {
  dispatchPluginInteractiveHandlerMock,
  dispatchReplyMock,
  resetDiscordComponentRuntimeMocks,
} from "../test-support/component-runtime.js";
import { createDiscordComponentControls } from "./agent-components.js";
import type { DiscordLivePolicy, DiscordLivePolicyReader } from "./live-policy.js";

const cfg: OpenClawConfig = {
  channels: { discord: { dmPolicy: "allowlist", allowFrom: ["123456789"] } },
};
const policy: DiscordLivePolicy = {
  isCurrent: () => true,
  accountId: "default",
  cfg,
  discordConfig: { dmPolicy: "allowlist", allowFrom: ["123456789"] },
  guildEntries: undefined,
  allowFrom: ["123456789"],
  dmPolicy: "allowlist",
  groupPolicy: "allowlist",
  dmEnabled: true,
  groupDmEnabled: false,
  groupDmChannels: [],
  allowNameMatching: false,
};

function createModalScenario(readPolicy: DiscordLivePolicyReader) {
  registerDiscordComponentEntries({
    entries: [{ id: "btn_1", kind: "modal-trigger", label: "Open form", modalId: "mdl_1" }],
    modals: [
      {
        id: "mdl_1",
        title: "Details",
        fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
      },
    ],
  });
  const createButton = createDiscordComponentControls[0];
  if (!createButton) {
    throw new Error("expected Discord button factory");
  }
  const button = createButton({ ...policy, readPolicy });
  const createButtonInteraction = (id: string) => {
    const client = createInternalTestClient();
    const post = vi.fn().mockResolvedValue(undefined);
    const patch = vi.fn();
    attachRestMock(client, { post, patch });
    const interaction = createInteraction(
      client,
      createInternalComponentInteractionPayload({
        id,
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
      throw new Error("expected Discord button interaction");
    }
    return { interaction, patch, post };
  };
  return { button, createButtonInteraction };
}

describe("Discord component policy deadlines", () => {
  beforeEach(() => {
    clearDiscordComponentEntriesForTest();
    resetDiscordComponentRuntimeMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["resolve", "reject"] as const)(
    "rejects a slow modal interaction without consuming it when policy later $0s",
    async (outcome) => {
      let resolvePolicy!: (value: DiscordLivePolicy) => void;
      let rejectPolicy!: (error: Error) => void;
      const pendingPolicy = new Promise<DiscordLivePolicy>((resolve, reject) => {
        resolvePolicy = resolve;
        rejectPolicy = reject;
      });
      const readPolicy = vi.fn(() => pendingPolicy);
      const { button, createButtonInteraction } = createModalScenario(readPolicy);
      const { interaction, post, patch } = createButtonInteraction("interaction-1");
      const data: ComponentData = { cid: "btn_1", mid: "mdl_1" };
      const run = button.run(interaction, data);

      await vi.advanceTimersByTimeAsync(1_001);

      expect(post).toHaveBeenCalledExactlyOnceWith(
        "/interactions/interaction-1/interaction-token/callback",
        {
          body: {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Access policy is still updating. Try this interaction again.",
              flags: MessageFlags.Ephemeral,
            },
          },
        },
      );
      await run;
      await expect(
        resolveDiscordComponentEntryWithPersistence({ id: "btn_1", consume: false }),
      ).resolves.toEqual(expect.objectContaining({ id: "btn_1" }));
      await expect(
        resolveDiscordModalEntryWithPersistence({ id: "mdl_1", consume: false }),
      ).resolves.toEqual(expect.objectContaining({ id: "mdl_1" }));

      if (outcome === "resolve") {
        resolvePolicy(policy);
      } else {
        rejectPolicy(new Error("late policy resolution failure"));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(1);
      expect(patch).not.toHaveBeenCalled();
      expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
      expect(dispatchReplyMock).not.toHaveBeenCalled();

      if (outcome === "resolve") {
        const next = createButtonInteraction("interaction-2");
        await button.run(next.interaction, data);
        expect(next.post).toHaveBeenCalledExactlyOnceWith(
          "/interactions/interaction-2/interaction-token/callback",
          expect.objectContaining({
            body: expect.objectContaining({ type: InteractionResponseType.Modal }),
          }),
        );
      }
    },
  );

  it("reports a policy failure without opening or consuming the modal", async () => {
    const error = new Error("policy is unavailable");
    const { button, createButtonInteraction } = createModalScenario(async () => {
      throw error;
    });
    const { interaction, post } = createButtonInteraction("interaction-error");

    await expect(button.run(interaction, { cid: "btn_1", mid: "mdl_1" })).rejects.toBe(error);

    expect(post).toHaveBeenCalledExactlyOnceWith(
      "/interactions/interaction-error/interaction-token/callback",
      {
        body: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: "Could not verify the current access policy. Try this interaction again.",
            flags: MessageFlags.Ephemeral,
          },
        },
      },
    );
    await expect(
      resolveDiscordComponentEntryWithPersistence({ id: "btn_1", consume: false }),
    ).resolves.toEqual(expect.objectContaining({ id: "btn_1" }));
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });
});
