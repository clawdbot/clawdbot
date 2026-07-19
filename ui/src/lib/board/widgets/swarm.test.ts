/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { renderSwarmWidget } from "./swarm.ts";

const parentSessionKey = "agent:main:parent";

function session(overrides: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key: "agent:main:child",
    kind: "direct",
    updatedAt: 1,
    parentSessionKey,
    swarmGroupId: "swarm:agent:main:parent:turn-42",
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("swarm board widget", () => {
  it("groups live collector children and maps their dot states", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderSwarmWidget({
        sessionKey: parentSessionKey,
        sessions: [
          session({ key: "queued", label: "Queued child", subagentRunState: "active" }),
          session({ key: "running", label: "Running child", status: "running" }),
          session({ key: "done", label: "Done child", status: "done" }),
          session({ key: "failed", label: "Timed out child", status: "timeout" }),
          session({
            key: "finished-group",
            swarmGroupId: "swarm:agent:main:parent:finished",
            status: "done",
          }),
        ],
      }),
      container,
    );

    const group = container.querySelector("[data-swarm-group]");
    expect(group?.getAttribute("data-swarm-group")).toBe("swarm:agent:main:parent:turn-42");
    expect(group?.textContent).toContain("turn-42");
    expect(group?.textContent?.replace(/\s+/g, " ")).toContain("1 Running · 1 Done · 1 Failed");
    expect(
      [...container.querySelectorAll(".swarm-widget__dot")].map((dot) => dot.className),
    ).toEqual([
      "swarm-widget__dot swarm-widget__dot--queued",
      "swarm-widget__dot swarm-widget__dot--running",
      "swarm-widget__dot swarm-widget__dot--done",
      "swarm-widget__dot swarm-widget__dot--failed",
    ]);
  });

  it("renders dot tooltips and keeps an empty state when no group is active", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderSwarmWidget({
        sessionKey: parentSessionKey,
        sessions: [session({ label: "Worker A", status: "running" })],
      }),
      container,
    );

    const dot = container.querySelector<HTMLElement>(".swarm-widget__dot--running");
    expect(dot?.title).toBe("Worker A: Running");
    expect(container.textContent).toContain("turn-42");
    expect(container.textContent?.replace(/\s+/g, " ")).toContain("1 Running · 0 Done · 0 Failed");

    render(renderSwarmWidget({ sessionKey: parentSessionKey, sessions: [] }), container);
    expect(container.querySelector("[data-test-id=swarm-empty]")?.textContent?.trim()).toBe(
      "No active swarms.",
    );
  });
});
