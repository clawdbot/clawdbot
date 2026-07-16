import { ComponentType, InteractionResponseType } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "../internal/discord.js";
import { createInteraction } from "../internal/interactions.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import type { AgentComponentContext } from "../monitor/agent-components.types.js";
import { buildDiscordPresentationComponents } from "../shared-interactive.js";
import { createDiscordActivityButton } from "./interaction.js";
import { setDiscordActivitiesRuntime } from "./runtime.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
} from "./test-helpers.test-support.js";

afterEach(() => {
  setDiscordActivitiesRuntime(undefined);
});

function componentContext(): AgentComponentContext {
  const cfg = createActivityTestConfig();
  return {
    cfg,
    accountId: "default",
    discordConfig: cfg.channels?.discord,
    allowFrom: ["42"],
    dmPolicy: "allowlist",
  };
}

describe("Discord Activity interaction", () => {
  it("does not claim unrelated component custom IDs", () => {
    setDiscordActivitiesRuntime(createActivityTestRuntime());
    const button = createDiscordActivityButton(componentContext(), "123456789012345678");
    expect(button?.customIdParser("other:key=value").key).toBe("other");
  });

  it("registers from the configured Activity application ID without a learned ID", () => {
    setDiscordActivitiesRuntime(createActivityTestRuntime());
    expect(createDiscordActivityButton(componentContext())).not.toBeNull();
  });

  it("posts a raw LAUNCH_ACTIVITY callback", async () => {
    const post = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalComponentInteractionPayload({
        id: "interaction-1",
        token: "itoken",
        data: { component_type: ComponentType.Button, custom_id: "ocactivity:v=1;wid=x" },
      }),
    ) as ButtonInteraction;

    await interaction.launchActivity();

    expect(post).toHaveBeenCalledWith("/interactions/interaction-1/itoken/callback", {
      body: { type: InteractionResponseType.LaunchActivity },
    });
  });

  it("launches for an authorized component click", async () => {
    const runtime = createActivityTestRuntime();
    setDiscordActivitiesRuntime(runtime);
    const authorize = vi.fn(async () => ({ commandAuthorized: true }));
    const reply = vi.fn(async () => undefined);
    const button = createDiscordActivityButton(componentContext(), "123456789012345678", {
      authorize: authorize as never,
      reply: reply as never,
    });
    const launchActivity = vi.fn(async () => undefined);
    const interaction = { launchActivity } as unknown as ButtonInteraction;
    const rendered = buildDiscordPresentationComponents({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Open widget",
              action: { type: "web-app", widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
            },
          ],
        },
      ],
    });
    const actionBlock = rendered?.blocks?.find((block) => block.type === "actions");
    const customId =
      actionBlock?.type === "actions" ? actionBlock.buttons?.[0]?.internalCustomId : "";
    const data = button?.customIdParser(customId ?? "").data ?? {};

    await button?.run(interaction, data);

    expect(authorize).toHaveBeenCalledOnce();
    expect(launchActivity).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it("replies ephemerally and does not launch when unauthorized", async () => {
    setDiscordActivitiesRuntime(createActivityTestRuntime());
    const reply = vi.fn(async () => undefined);
    const button = createDiscordActivityButton(componentContext(), "123456789012345678", {
      authorize: vi.fn(async () => ({ commandAuthorized: false })) as never,
      reply: reply as never,
    });
    const launchActivity = vi.fn(async () => undefined);
    const interaction = { launchActivity } as unknown as ButtonInteraction;

    await button?.run(interaction, { widgetId: "AAAAAAAAAAAAAAAAAAAAAA" });

    expect(reply).toHaveBeenCalledWith(interaction, { content: "not allowed", ephemeral: true });
    expect(launchActivity).not.toHaveBeenCalled();
  });
});
