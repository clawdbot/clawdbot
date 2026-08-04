/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "./workboard-card-chip.runtime.ts";

type WorkboardCardChipElement = HTMLElementTagNameMap["openclaw-workboard-card-chip"] & {
  updateComplete: Promise<boolean>;
};

const mounted: WorkboardCardChipElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

describe("Workboard card chip", () => {
  it("loads the matching card and releases its shared lookup lease", async () => {
    const removeListener = vi.fn();
    const request = vi.fn(async () => ({
      cards: [
        {
          id: "card-1",
          title: "Ship dashboard stitch",
          status: "review",
          priority: "normal",
          labels: [],
          position: 1,
          createdAt: 1,
          updatedAt: 2,
          sessionKey: "agent:main:workboard-card",
          metadata: { automation: { boardId: "platform" } },
        },
      ],
    }));
    const addEventListener = vi.fn(() => removeListener);
    const client = {
      request,
      addEventListener,
    } as unknown as GatewayBrowserClient;
    const element = document.createElement("openclaw-workboard-card-chip");
    element.basePath = "/control";
    element.client = client;
    element.sessionKey = "agent:main:workboard-card";
    document.body.append(element);
    mounted.push(element);

    await vi.waitFor(() =>
      expect(element.querySelector(".board-session-surface__workboard-chip")).not.toBeNull(),
    );
    const link = element.querySelector<HTMLAnchorElement>(".board-session-surface__workboard-chip");
    expect(link?.getAttribute("href")).toBe("/control/workboard?board=platform");
    expect(link?.textContent).toContain("Ship dashboard stitch");
    expect(link?.textContent).toContain("Review");
    expect(request).toHaveBeenCalledWith("workboard.cards.list", {});

    element.remove();
    await element.updateComplete;
    expect(removeListener).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledOnce();

    document.body.append(element);
    await vi.waitFor(() => expect(addEventListener).toHaveBeenCalledTimes(2));
  });
});
