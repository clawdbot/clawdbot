// @vitest-environment node
import { expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { SessionActivityController } from "./session-activity-controller.ts";

it("keeps the same-query snapshot during invalidation and clears it on person changes", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const result = {
    ts: 1,
    path: "",
    count: 0,
    sessions: [],
    defaults: { model: null, modelProvider: null, contextTokens: null },
    involvingProfileId: "current",
  };
  const request = vi.spyOn(client, "request").mockResolvedValue(result);
  const controller = new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  });
  const filters = { personId: "former", time: "all" as const, query: "" };
  controller.load(client, filters);
  await vi.waitFor(() => expect(controller.result).toEqual(result));
  controller.load(client, filters, true);
  expect(controller.result).toEqual(result);
  expect(request).toHaveBeenLastCalledWith(
    "sessions.list",
    expect.objectContaining({ involvingProfileId: "former", includePeople: true }),
    expect.anything(),
  );
  controller.load(client, { ...filters, personId: "other" });
  expect(controller.result).toBeUndefined();
  controller.hostDisconnected();
});
