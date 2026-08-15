// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { sendSessionObserverVisibility } from "./chat-observer.ts";

describe("chat observer visibility rpc", () => {
  it("sends the connection visibility declaration", async () => {
    const request = vi.fn(async () => ({ ok: true as const }));

    await expect(
      sendSessionObserverVisibility(
        { request } as unknown as Pick<GatewayBrowserClient, "request">,
        false,
      ),
    ).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("sessions.observer.visibility", { visible: false });
  });
});
