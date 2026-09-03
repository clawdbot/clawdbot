import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_CREATE_RETRY_WINDOW_MS } from "../../../../packages/gateway-protocol/src/index.js";
import { DraftSessionStartup } from "./draft-session-startup.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function createStartup() {
  const gateway = { connected: true, sessionCreateScope: "gateway:principal:boot-a" };
  const startup = new DraftSessionStartup(gateway);
  const params = startup.start({ agentId: "main", message: "preserve this task" });
  return { gateway, params, startup };
}

describe("DraftSessionStartup", () => {
  it("resumes the exact frozen direct-create intent once on the same Gateway scope", () => {
    const { params, startup } = createStartup();
    expect(params).toMatchObject({
      agentId: "main",
      idempotencyKey: expect.any(String),
      message: "preserve this task",
    });
    expect(Object.isFrozen(params)).toBe(true);
    expect(startup.interrupt()).toBe(true);

    const resumed = startup.resume();
    expect(resumed).toMatchObject({ kind: "resume", params, startedAt: expect.any(Number) });
    if (resumed.kind === "resume") {
      expect(resumed.params).toBe(params);
    }
    expect(startup.resume()).toEqual({ kind: "wait" });
  });

  it("fails closed and unlocks when the Gateway scope or process boot changes", () => {
    const { gateway, startup } = createStartup();
    startup.interrupt();
    gateway.sessionCreateScope = "gateway:principal:boot-b";

    expect(startup.resume()).toEqual({ kind: "owner-changed" });
    expect(startup.active).toBe(false);
  });

  it("waits for reconnection without consulting mutable draft selections", () => {
    const { gateway, params, startup } = createStartup();
    startup.interrupt();
    gateway.connected = false;

    expect(startup.resume()).toEqual({ kind: "wait" });
    expect(startup.active).toBe(true);
    gateway.connected = true;
    expect(startup.resume()).toMatchObject({ kind: "resume", params });
  });

  it("expires and unlocks at the shared client retry deadline", () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { startup } = createStartup();
    startup.interrupt();
    now += SESSION_CREATE_RETRY_WINDOW_MS;

    expect(startup.resume()).toEqual({ kind: "expired" });
    expect(startup.active).toBe(false);
  });
});
