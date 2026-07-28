import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { maybeHandleMSTeamsApprovalControl } from "./approval-control.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const resolveApprovalOverGateway = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway,
}));

const APPROVER_ID = "5e4b4b6f-c242-45de-b0de-bf44eb233145";
const OTHER_ID = "6e4b4b6f-c242-45de-b0de-bf44eb233146";

function createDeps(): MSTeamsMessageHandlerDeps {
  return {
    cfg: {
      channels: {
        msteams: {
          allowFrom: [APPROVER_ID],
        },
      },
    } as OpenClawConfig,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    appId: "test-app",
    app: {} as MSTeamsMessageHandlerDeps["app"],
    tokenProvider: {
      getAccessToken: vi.fn(async () => "token"),
    },
    textLimit: 4000,
    mediaMaxBytes: 1024,
    conversationStore: {} as MSTeamsMessageHandlerDeps["conversationStore"],
    pollStore: {} as MSTeamsMessageHandlerDeps["pollStore"],
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as MSTeamsMessageHandlerDeps["log"],
  };
}

function createContext(senderId: string): MSTeamsTurnContext {
  return {
    activity: {
      type: "message",
      from: {
        id: "bot-framework-user",
        aadObjectId: senderId,
      },
      conversation: {
        id: "19:personal-chat",
        conversationType: "personal",
      },
    },
  } as MSTeamsTurnContext;
}

describe("msteams approval control", () => {
  beforeEach(() => {
    resolveApprovalOverGateway.mockClear();
  });

  it("resolves an authorized plugin approval before agent dispatch", async () => {
    const handled = await maybeHandleMSTeamsApprovalControl({
      context: createContext(APPROVER_ID),
      deps: createDeps(),
      text: "/approve plugin:approval-123 allow-once",
    });

    expect(handled).toBe(true);
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      approvalId: "plugin:approval-123",
      decision: "allow-once",
      senderId: APPROVER_ID,
      allowPluginFallback: false,
      clientDisplayName: `Microsoft Teams approval (${APPROVER_ID})`,
    });
  });

  it("consumes but does not resolve an unauthorized approval command", async () => {
    const handled = await maybeHandleMSTeamsApprovalControl({
      context: createContext(OTHER_ID),
      deps: createDeps(),
      text: "/approve plugin:approval-123 allow-once",
    });

    expect(handled).toBe(true);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("leaves non-approval text on the normal message path", async () => {
    const handled = await maybeHandleMSTeamsApprovalControl({
      context: createContext(APPROVER_ID),
      deps: createDeps(),
      text: "ok",
    });

    expect(handled).toBe(false);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });
});
