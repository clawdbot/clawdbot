import { describe, expect, it } from "vitest";
import { discordApprovalNativeRuntime } from "./approval-handler.runtime.js";

describe("discordApprovalNativeRuntime", () => {
  it("routes origin approval updates to the Discord thread channel when threadId is present", async () => {
    const prepared = await discordApprovalNativeRuntime.transport.prepareTarget({
      cfg: {} as never,
      accountId: "main",
      context: {
        token: "discord-token",
        config: {} as never,
      },
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "123456789",
          threadId: "777888999",
        },
      },
      request: {
        id: "req-1",
        request: {
          command: "hostname",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "exec",
      view: {} as never,
      pendingPayload: {} as never,
    });

    expect(prepared).toEqual({
      dedupeKey: "777888999",
      target: {
        discordChannelId: "777888999",
      },
    });
  });
});
