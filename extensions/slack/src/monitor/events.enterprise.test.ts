// Slack tests cover Enterprise Grid event registration boundaries.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackMessageHandler } from "./message-handler.js";

const registrations = vi.hoisted(() => ({
  agent: vi.fn(),
  assistant: vi.fn(),
  channel: vi.fn(),
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
vi.mock("./events/channels.js", () => ({ registerSlackChannelEvents: registrations.channel }));
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

let registerSlackMonitorEvents: typeof import("./events.js").registerSlackMonitorEvents;

function registerForInstallation(kind: "enterprise" | "workspace") {
  const installationIdentity =
    kind === "enterprise"
      ? ({ kind, enterpriseId: "E_TEST" } as const)
      : ({ kind, teamId: "T_TEST" } as const);
  registerSlackMonitorEvents({
    ctx: { installationIdentity } as SlackMonitorContext,
    account: {} as ResolvedSlackAccount,
    handleSlackMessage: vi.fn() as SlackMessageHandler,
  });
}

describe("registerSlackMonitorEvents", () => {
  beforeAll(async () => {
    ({ registerSlackMonitorEvents } = await import("./events.js"));
  });

  beforeEach(() => {
    for (const registration of Object.values(registrations)) {
      registration.mockClear();
    }
  });

  it("registers messages, reactions, pins, and member events for enterprise installs", () => {
    registerForInstallation("enterprise");

    expect(registrations.message).toHaveBeenCalledOnce();
    expect(registrations.reaction).toHaveBeenCalledOnce();
    expect(registrations.pin).toHaveBeenCalledOnce();
    expect(registrations.member).toHaveBeenCalledOnce();
    expect(registrations.channel).not.toHaveBeenCalled();
    expect(registrations.home).not.toHaveBeenCalled();
    expect(registrations.agent).not.toHaveBeenCalled();
    expect(registrations.interaction).not.toHaveBeenCalled();
    expect(registrations.assistant).not.toHaveBeenCalled();
  });

  it("preserves the full event set for workspace installs", () => {
    registerForInstallation("workspace");

    for (const registration of Object.values(registrations)) {
      expect(registration).toHaveBeenCalledOnce();
    }
  });
});
