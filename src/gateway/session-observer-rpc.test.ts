import { describe, expect, it, vi } from "vitest";
import { sessionObserverHandlers } from "./session-observer-rpc.js";

describe("sessions.observer.visibility", () => {
  it("records visibility for the authenticated connection", async () => {
    const respond = vi.fn();
    const setConnectionVisibility = vi.fn();
    await sessionObserverHandlers["sessions.observer.visibility"]?.({
      params: { visible: true },
      client: { connId: "conn-1" },
      context: { sessionObserver: { setConnectionVisibility } },
      respond,
    } as never);

    expect(setConnectionVisibility).toHaveBeenCalledWith("conn-1", true);
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it.each([{}, { visible: "true" }])("rejects invalid params %#", async (params) => {
    const respond = vi.fn();
    await sessionObserverHandlers["sessions.observer.visibility"]?.({
      params,
      client: { connId: "conn-1" },
      context: { sessionObserver: { setConnectionVisibility: vi.fn() } },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
