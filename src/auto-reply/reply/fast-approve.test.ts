import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildTestCtx } from "./test-ctx.js";

const { handleApproveCommandFromContextMock } = vi.hoisted(() => ({
  handleApproveCommandFromContextMock: vi.fn(),
}));

vi.mock("./commands-approve.js", () => ({
  handleApproveCommandFromContext: (...args: unknown[]) =>
    handleApproveCommandFromContextMock(...args),
}));

const { tryFastApproveFromMessage } = await import("./fast-approve.js");

describe("tryFastApproveFromMessage", () => {
  beforeEach(() => {
    handleApproveCommandFromContextMock.mockReset();
  });

  it("delegates an external text /approve before session admission", async () => {
    handleApproveCommandFromContextMock.mockResolvedValue({
      shouldContinue: false,
      reply: { text: "Approval submitted." },
    });
    const ctx = buildTestCtx({
      Body: "/approve exec-1 allow-once",
      BodyForCommands: "/approve exec-1 allow-once",
      CommandBody: "/approve exec-1 allow-once",
      CommandSource: "text",
      CommandAuthorized: true,
      Provider: "imessage",
      Surface: "imessage",
      ChatType: "direct",
    });

    await expect(
      tryFastApproveFromMessage({
        ctx,
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:imessage:direct:peer",
      }),
    ).resolves.toEqual({ handled: true, reply: { text: "Approval submitted." } });
    expect(handleApproveCommandFromContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          commandBodyNormalized: "/approve exec-1 allow-once",
          isAuthorizedSender: true,
        }),
      }),
      true,
    );
  });

  it("keeps authorization in the approval command owner", async () => {
    handleApproveCommandFromContextMock.mockResolvedValue({ shouldContinue: false });
    const ctx = buildTestCtx({
      Body: "/approve exec-1 allow-once",
      CommandBody: "/approve exec-1 allow-once",
      CommandSource: "text",
      CommandAuthorized: false,
      Provider: "imessage",
      Surface: "imessage",
      ChatType: "direct",
    });

    await expect(tryFastApproveFromMessage({ ctx, cfg: {} as OpenClawConfig })).resolves.toEqual({
      handled: true,
    });
    expect(handleApproveCommandFromContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ isAuthorizedSender: false }),
      }),
      true,
    );
  });

  it("uses the canonical command text instead of iMessage reply context", async () => {
    handleApproveCommandFromContextMock.mockResolvedValue({
      shouldContinue: false,
      reply: { text: "Approval submitted." },
    });
    const ctx = buildTestCtx({
      Body: "[Replying to an approval prompt]\nquoted approval text",
      CommandBody: "/approve exec-1 allow-once",
      CommandSource: "text",
      CommandAuthorized: true,
      Provider: "imessage",
      Surface: "imessage",
      ChatType: "direct",
    });

    await expect(tryFastApproveFromMessage({ ctx, cfg: {} as OpenClawConfig })).resolves.toEqual({
      handled: true,
      reply: { text: "Approval submitted." },
    });
    expect(handleApproveCommandFromContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          commandBodyNormalized: "/approve exec-1 allow-once",
        }),
      }),
      true,
    );
  });

  it("does not promote a quoted approval command from an arbitrary message line", async () => {
    const ctx = buildTestCtx({
      Body: "Please explain this command:\n/approve exec-1 allow-once",
      CommandBody: "Please explain this command:\n/approve exec-1 allow-once",
      CommandAuthorized: true,
      Provider: "imessage",
      Surface: "imessage",
      ChatType: "direct",
    });

    await expect(tryFastApproveFromMessage({ ctx, cfg: {} as OpenClawConfig })).resolves.toEqual({
      handled: false,
    });
    expect(handleApproveCommandFromContextMock).not.toHaveBeenCalled();
  });

  it("ignores ordinary text", async () => {
    const ctx = buildTestCtx({
      Body: "hello",
      Provider: "imessage",
    });
    await expect(tryFastApproveFromMessage({ ctx, cfg: {} as OpenClawConfig })).resolves.toEqual({
      handled: false,
    });
    expect(handleApproveCommandFromContextMock).not.toHaveBeenCalled();
  });
});
