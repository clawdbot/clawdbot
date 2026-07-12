import { describe, expect, it, vi } from "vitest";
import { requestSessionCreate } from "./create.ts";

describe("requestSessionCreate", () => {
  it("returns the started initial-run outcome", async () => {
    const client = {
      request: vi.fn(async () => ({
        key: " agent:main:dashboard:new ",
        runStarted: true,
      })),
    };

    await expect(requestSessionCreate(client as never, { message: "hello" })).resolves.toEqual({
      key: "agent:main:dashboard:new",
      initialRun: { status: "started" },
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
        error: "The session was created, but its first message could not be sent.",
      },
    });
  });
});
