import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { maybeHandleMSTeamsApprovalControl } from "./approval-control.js";
import { installMSTeamsTestRuntime } from "./monitor-handler.test-helpers.js";
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
    sendActivity: vi.fn(async () => ({ id: "status-activity" })),
  } as unknown as MSTeamsTurnContext;
}

describe("msteams approval control", () => {
  beforeEach(() => {
    installMSTeamsTestRuntime();
    resolveApprovalOverGateway.mockClear();
  });

  it.each([
    ["canonical id-first", "/approve plugin:approval-123 allow-once", "allow-once"],
    ["decision alias", "/approve plugin:approval-123 always", "allow-always"],
    ["decision-first", "/approve always plugin:approval-123", "allow-always"],
    ["allow alias", "/approve plugin:approval-123 allow", "allow-once"],
    ["bot mention", "/approve@openclaw plugin:approval-123 allowonce", "allow-once"],
    [
      "native Teams mention",
      "<at>OpenClaw QA</at> /approve allowonce plugin:approval-123",
      "allow-once",
    ],
    ["deny alias", "/approve plugin:approval-123 reject", "deny"],
  ] as const)(
    "resolves an authorized plugin approval before agent dispatch: %s",
    async (_name, text, decision) => {
      const handled = await maybeHandleMSTeamsApprovalControl({
        context: createContext(APPROVER_ID),
        deps: createDeps(),
        text,
      });

      expect(handled).toBe(true);
      expect(resolveApprovalOverGateway).toHaveBeenCalledWith({
        cfg: expect.any(Object),
        approvalId: "plugin:approval-123",
        decision,
        senderId: APPROVER_ID,
        approvalKind: "plugin",
        clientDisplayName: `Microsoft Teams approval (${APPROVER_ID})`,
      });
    },
  );

  it("resolves exec approvals through the canonical exec owner", async () => {
    const context = createContext(APPROVER_ID);
    const handled = await maybeHandleMSTeamsApprovalControl({
      context,
      deps: createDeps(),
      text: "/approve exec-approval-123 deny",
    });

    expect(handled).toBe(true);
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      approvalId: "exec-approval-123",
      decision: "deny",
      senderId: APPROVER_ID,
      approvalKind: "exec",
      clientDisplayName: `Microsoft Teams approval (${APPROVER_ID})`,
    });
    expect(context.sendActivity).toHaveBeenCalledWith(
      "✅ Approval deny submitted for exec-approval-123.",
    );
  });

  it("consumes gateway failures and sends a generic failure status", async () => {
    resolveApprovalOverGateway.mockRejectedValueOnce(new Error("gateway secret detail"));
    const context = createContext(APPROVER_ID);

    const handled = await maybeHandleMSTeamsApprovalControl({
      context,
      deps: createDeps(),
      text: "/approve plugin:approval-123 allow-once",
    });

    expect(handled).toBe(true);
    expect(context.sendActivity).toHaveBeenCalledWith("❌ Failed to submit approval.");
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

  it("does not treat the implicit same-chat fallback as explicit authorization", async () => {
    const deps = createDeps();
    deps.cfg = {} as OpenClawConfig;

    const handled = await maybeHandleMSTeamsApprovalControl({
      context: createContext(OTHER_ID),
      deps,
      text: "/approve plugin:approval-123 allow-once",
    });

    expect(handled).toBe(true);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("does not intercept approvals when text commands are disabled", async () => {
    installMSTeamsTestRuntime({ shouldHandleTextCommands: () => false });

    const handled = await maybeHandleMSTeamsApprovalControl({
      context: createContext(APPROVER_ID),
      deps: createDeps(),
      text: "/approve plugin:approval-123 allow-once",
    });

    expect(handled).toBe(false);
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
