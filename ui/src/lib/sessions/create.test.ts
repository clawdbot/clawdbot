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
        entry: { thinkingLevel: "xhigh", updatedAt: 10 },
        runStarted: true,
        runId: "initial-send-id",
        messageSeq: 7,
      })),
    };

    await expect(
      requestSessionCreate(client as never, { message: "hello", thinkingLevel: "xhigh" }),
    ).resolves.toEqual({
      key: "agent:main:dashboard:new",
      entry: { thinkingLevel: "xhigh", updatedAt: 10 },
      initialRun: { status: "started", runId: "initial-send-id", messageSeq: 7 },
    });
  });

  it("does not version a request fallback with an unrelated entry timestamp", async () => {
    const client = {
      request: vi.fn(async () => ({ key: "agent:main:fallback", entry: { updatedAt: 10 } })),
    };

    await expect(
      requestSessionCreate(client as never, { thinkingLevel: "xhigh" }),
    ).resolves.toEqual({
      key: "agent:main:fallback",
      entry: { updatedAt: 10 },
      initialRun: { status: "idle" },
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
      entry: undefined,
      initialRun: { status: "idle" },
    });
    await expect(
      requestSessionCreate(rejectedClient as never, { message: "hello" }),
    ).resolves.toEqual({
      key: "agent:main:dashboard:rejected",
      entry: undefined,
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
      entry: undefined,
      initialRun: {
        status: "rejected",
        error: "The session was created, but its first message could not be sent.",
      },
    });
  });
});
