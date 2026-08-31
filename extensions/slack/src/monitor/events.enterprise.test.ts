// Slack tests cover Enterprise Grid event registration boundaries.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";
import type { SlackMessageHandler } from "./message-handler.js";

const registrations = vi.hoisted(() => ({
  agent: vi.fn(),
  assistant: vi.fn(),
  channel: vi.fn(),
  channelIdChanged: vi.fn(),
  home: vi.fn(),
  interaction: vi.fn(),
  member: vi.fn(),
  message: vi.fn(),
  pin: vi.fn(),
  reaction: vi.fn(),
}));

vi.mock("./events/agent.js", () => ({ registerSlackAgentEvents: registrations.agent }));
vi.mock("./events/assistant.js", () => ({
  registerSlackAssistantEvents: registrations.assistant,
}));
vi.mock("./events/channels.js", () => ({
  registerSlackChannelEvents: registrations.channel,
  registerSlackChannelIdChangedEvent: registrations.channelIdChanged,
}));
vi.mock("./events/home.js", () => ({ registerSlackHomeEvents: registrations.home }));
vi.mock("./events/interactions.js", () => ({
  registerSlackInteractionEvents: registrations.interaction,
}));
vi.mock("./events/members.js", () => ({ registerSlackMemberEvents: registrations.member }));
vi.mock("./events/messages.js", () => ({ registerSlackMessageEvents: registrations.message }));
vi.mock("./events/pins.js", () => ({ registerSlackPinEvents: registrations.pin }));
vi.mock("./events/reactions.js", () => ({
  registerSlackReactionEvents: registrations.reaction,
}));

let registerSlackCommonEvents: typeof import("./events.js").registerSlackCommonEvents;
let registerSlackWorkspaceEvents: typeof import("./events.js").registerSlackWorkspaceEvents;

function registerCommonEvents() {
  registerSlackCommonEvents({
    ctx: {} as SlackMonitorContext,
    handleSlackMessage: vi.fn() as SlackMessageHandler,
  });
}

describe("Slack event registration", () => {
  beforeAll(async () => {
    ({ registerSlackCommonEvents, registerSlackWorkspaceEvents } = await import("./events.js"));
  });

  beforeEach(() => {
    for (const registration of Object.values(registrations)) {
      registration.mockClear();
    }
  });

  it("registers the Enterprise-capable common event set without workspace-only listeners", () => {
    registerCommonEvents();

    expect(registrations.message).toHaveBeenCalledOnce();
    expect(registrations.reaction).toHaveBeenCalledOnce();
    expect(registrations.pin).toHaveBeenCalledOnce();
    expect(registrations.member).toHaveBeenCalledOnce();
    expect(registrations.channel).toHaveBeenCalledOnce();
    expect(registrations.channelIdChanged).not.toHaveBeenCalled();
    expect(registrations.home).not.toHaveBeenCalled();
    expect(registrations.agent).not.toHaveBeenCalled();
    expect(registrations.interaction).toHaveBeenCalledOnce();
    expect(registrations.assistant).not.toHaveBeenCalled();
  });

  it("adds workspace-only listeners without duplicating the common event set", () => {
    registerCommonEvents();
    registerSlackWorkspaceEvents({ ctx: {} as SlackMonitorContext });

    for (const registration of Object.values(registrations)) {
      expect(registration).toHaveBeenCalledOnce();
    }
  });
});
