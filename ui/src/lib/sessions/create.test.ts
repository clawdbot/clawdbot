import { describe, expect, it, vi } from "vitest";
import { requestSessionCreate, resolveSessionCreateParams } from "./create.ts";

describe("resolveSessionCreateParams", () => {
  it("marks a Control UI child as parallel to its selected parent", () => {
    expect(resolveSessionCreateParams(" agent:main:signal:direct:42 ", " main ")).toEqual({
      agentId: "main",
      parentSessionKey: "agent:main:signal:direct:42",
      emitCommandHooks: true,
      succeedsParent: false,
    });
  });
});

describe("requestSessionCreate", () => {
  it("returns the started initial-run outcome", async () => {
    const client = {
      request: vi.fn(async () => ({
        key: " agent:main:dashboard:new ",
        runStarted: true,
        runId: "initial-send-id",
        messageSeq: 7,
      })),
    };

    await expect(requestSessionCreate(client as never, { message: "hello" })).resolves.toEqual({
      key: "agent:main:dashboard:new",
      initialRun: { status: "started", messageId: "initial-send-id", messageSeq: 7 },
    });
  });

  it("keeps an idle session distinct from a rejected initial run", async () => {
    const idleClient = {
      request: vi.fn(async () => ({ key: "agent:main:dashboard:idle", runStarted: false })),
    };
    const rejectedClient = {
      request: vi.fn(async () => ({
        key: "agent:main:dashboard:rejected",
        runStarted: false,
        runError: { code: "INVALID_REQUEST", message: "send blocked by session policy" },
      })),
    };

    await expect(requestSessionCreate(idleClient as never)).resolves.toEqual({
      key: "agent:main:dashboard:idle",
      initialRun: { status: "idle" },
    });
    await expect(
      requestSessionCreate(rejectedClient as never, { message: "hello" }),
    ).resolves.toEqual({
      key: "agent:main:dashboard:rejected",
      initialRun: { status: "rejected", error: "send blocked by session policy" },
    });
  });

  it("uses an actionable fallback for a malformed run error", async () => {
    const client = {
      request: vi.fn(async () => ({
        key: "agent:main:dashboard:rejected",
        runError: {},
      })),
    };

    await expect(requestSessionCreate(client as never, { message: "hello" })).resolves.toEqual({
      key: "agent:main:dashboard:rejected",
      initialRun: {
        status: "rejected",
        error: "The thread was created, but its first message could not be sent.",
      },
    });
  });
});
