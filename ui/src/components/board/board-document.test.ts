import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import "./board-document.ts";

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

it("binds an acknowledged conversation only while the dashboard document is mounted", async () => {
  const request = vi.fn(async (method: string) =>
    method === "sessions.describe"
      ? { session: { key: "global", agentId: "work" } }
      : { sessionKey: "agent:work:global", revision: 1, tabs: [], widgets: [] },
  );
  const removeListener = vi.fn();
  const client = {
    request,
    addEventListener: vi.fn(() => removeListener),
  } as unknown as GatewayBrowserClient;
  const element = document.createElement("openclaw-board-document");
  mounted.push(element);
  element.sessionKey = "agent:work:main";
  element.gatewaySnapshot = {
    client,
    phase: "connected",
    hello: { features: { methods: ["board.get"] } },
  } as ApplicationGatewaySnapshot;
  document.body.append(element);
  element.remove();
  await element.updateComplete;
  expect(request).not.toHaveBeenCalled();

  document.body.append(element);
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("board.get", {
      sessionKey: "global",
      agentId: "work",
    }),
  );
  await element.updateComplete;
  expect(element.querySelector("openclaw-board-view")).not.toBeNull();
  element.remove();
  await element.updateComplete;
  expect(removeListener).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(2);

  document.body.append(element);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  expect(request).toHaveBeenLastCalledWith("board.get", { sessionKey: "global", agentId: "work" });
});
