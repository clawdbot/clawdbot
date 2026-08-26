import { ComponentType, InteractionResponseType } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
        data: {
          component_type: ComponentType.Button,
          custom_id: "ocactivity1_AAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    ) as ButtonInteraction;

    await interaction.launchActivity();

    expect(post).toHaveBeenCalledWith("/interactions/interaction-1/itoken/callback", {
      body: { type: InteractionResponseType.LaunchActivity },
    });
  });

  it("launches for a channel member outside the agent allowlist", async () => {
    const runtime = createActivityTestRuntime();
    setDiscordActivitiesRuntime(runtime);
    const reply = vi.fn(async () => undefined);
    const button = createDiscordActivityButton(componentContext(), "123456789012345678", {
      reply: reply as never,
    });
    const launchActivity = vi.fn(async () => undefined);
    const interaction = {
      launchActivity,
      rawData: { channel_id: "777" },
      userId: "99",
    } as unknown as ButtonInteraction;
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

    expect(launchActivity).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    await expect(runtime.store.consumePendingLaunch("default", "777", "99")).resolves.toMatchObject(
      { widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
    );
  });

  it("records the pending launch before acknowledging the interaction", async () => {
    const runtime = createActivityTestRuntime();
    setDiscordActivitiesRuntime(runtime);
    const recordPendingLaunch = vi.spyOn(runtime.store, "recordPendingLaunch");
    const button = createDiscordActivityButton(componentContext(), "123456789012345678", {
      reply: vi.fn(async () => undefined) as never,
    });
    if (!button) {
      throw new Error("expected activity button");
    }
    const launchActivity = vi.fn(async () => undefined);
    const interaction = {
      launchActivity,
      rawData: { channel_id: "777" },
      userId: "42",
    } as unknown as ButtonInteraction;
    await button.run(interaction, { widgetId: "AAAAAAAAAAAAAAAAAAAAAA" });

    expect(recordPendingLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        channelId: "777",
        discordUserId: "42",
      }),
    );
    expect(launchActivity).toHaveBeenCalledOnce();
    // The bounded await establishes visibility before the Activity can query api/widget.
    const writeOrder = recordPendingLaunch.mock.invocationCallOrder[0] ?? Number.NaN;
    const launchOrder = launchActivity.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(writeOrder).toBeLessThan(launchOrder);
  });

  it("clears the exact watchdog handle when the pending launch write wins", async () => {
    const runtime = createActivityTestRuntime();
    setDiscordActivitiesRuntime(runtime);
    const nativeSetTimeout = globalThis.setTimeout;
    let watchdogHandle: ReturnType<typeof setTimeout> | undefined;
    let watchdogFired = false;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ): ReturnType<typeof setTimeout> => {
      const handle = nativeSetTimeout(() => {
        if (delay === 250) {
          watchdogFired = true;
        }
        callback(...args);
      }, delay);
      if (delay === 250) {
        watchdogHandle = handle;
      }
      return handle;
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const button = createDiscordActivityButton(componentContext(), "123456789012345678", {
      reply: vi.fn(async () => undefined) as never,
    });
    if (!button) {
      throw new Error("expected activity button");
    }
    const launchActivity = vi.fn(async () => undefined);
    const interaction = {
      launchActivity,
      rawData: { channel_id: "777" },
      userId: "42",
    } as unknown as ButtonInteraction;

    try {
      await button.run(interaction, { widgetId: "AAAAAAAAAAAAAAAAAAAAAA" });

      expect(watchdogHandle).toBeDefined();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(watchdogHandle);
      await new Promise<void>((resolve) => {
        nativeSetTimeout(resolve, 275);
      });
      expect(watchdogFired).toBe(false);
      expect(launchActivity).toHaveBeenCalledOnce();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("launches after the write budget when the store stalls and logs once", async () => {
    const runtime = createActivityTestRuntime();
    setDiscordActivitiesRuntime(runtime);
    const pendingWrite = createDeferred<void>();
    let backgroundSettled = false;
    const stalledWrite = pendingWrite.promise.then(() => {
      backgroundSettled = true;
    });
    vi.spyOn(runtime.store, "recordPendingLaunch").mockReturnValue(stalledWrite);
    const logError = vi.fn();
    const button = createDiscordActivityButton(componentContext(), "123456789012345678", {
      reply: vi.fn(async () => undefined) as never,
      logError,
    });
    if (!button) {
      throw new Error("expected activity button");
    }
    const launchActivity = vi.fn(async () => undefined);
    const interaction = {
      launchActivity,
      rawData: { channel_id: "777" },
      userId: "42",
    } as unknown as ButtonInteraction;
    const startedAt = performance.now();
    try {
      await button.run(interaction, { widgetId: "AAAAAAAAAAAAAAAAAAAAAA" });
      const elapsedMs = performance.now() - startedAt;
      expect(launchActivity).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalledTimes(1);
      expect(String(logError.mock.calls[0]?.[0])).toContain("exceeded");
      expect(elapsedMs).toBeGreaterThanOrEqual(240);
      expect(backgroundSettled).toBe(false);
    } finally {
      pendingWrite.resolve();
      await stalledWrite;
    }
    expect(backgroundSettled).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("still launches when recording the pending launch fails and logs once", async () => {
    const runtime = createActivityTestRuntime();
    setDiscordActivitiesRuntime(runtime);
    const recordPendingLaunch = vi
      .spyOn(runtime.store, "recordPendingLaunch")
      .mockRejectedValue(new Error("store offline"));
    const logError = vi.fn();
    const button = createDiscordActivityButton(componentContext(), "123456789012345678", {
      reply: vi.fn(async () => undefined) as never,
      logError,
    });
    const launchActivity = vi.fn(async () => undefined);
    const interaction = {
      launchActivity,
      rawData: { channel_id: "777" },
      userId: "42",
    } as unknown as ButtonInteraction;

    await button?.run(interaction, { widgetId: "AAAAAAAAAAAAAAAAAAAAAA" });
    await button?.run(interaction, { widgetId: "AAAAAAAAAAAAAAAAAAAAAA" });

    expect(recordPendingLaunch).toHaveBeenCalledTimes(2);
    expect(launchActivity).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(logError).toHaveBeenCalledOnce());
  });

  it("replies ephemerally and does not launch for invalid widget data", async () => {
    setDiscordActivitiesRuntime(createActivityTestRuntime());
    const reply = vi.fn(async () => undefined);
    const button = createDiscordActivityButton(componentContext(), "123456789012345678", {
      reply: reply as never,
    });
    const launchActivity = vi.fn(async () => undefined);
    const interaction = { launchActivity } as unknown as ButtonInteraction;

    await button?.run(interaction, {});

    expect(reply).toHaveBeenCalledWith(interaction, {
      content: "This widget is no longer valid.",
      ephemeral: true,
    });
    expect(launchActivity).not.toHaveBeenCalled();
  });
});
