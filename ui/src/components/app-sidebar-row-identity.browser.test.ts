import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("sidebar session row DOM identity", () => {
  it("moves existing row DOM when a new session shifts the list", async () => {
    await import("./app-sidebar.ts");
    const { createGatewayHarness, createSessionsHarness, createSessionState, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const harness = createSessionsHarness("main", ["agent:main:alpha", "agent:main:beta"]);
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      harness.sessions,
    );
    sidebar.connected = true;
    await sidebar.updateComplete;

    const rowFor = (key: string) =>
      sidebar.querySelector<HTMLElement>(`[data-session-tree="${key}"]`);
    const alphaBefore = rowFor("agent:main:alpha");
    const betaBefore = rowFor("agent:main:beta");
    expect(alphaBefore).not.toBeNull();
    expect(betaBefore).not.toBeNull();

    // A newly created session sorts first (createdAt desc) and shifts every
    // existing row's position; keyed reuse must move their DOM, not rebuild it.
    const next = createSessionState("main", [
      "agent:main:alpha",
      "agent:main:beta",
      "agent:main:gamma",
    ]);
    const gamma = next.result?.sessions.find((row) => row.key === "agent:main:gamma");
    if (gamma) {
      gamma.createdAt = Date.now();
    }
    harness.publishList(next);
    await sidebar.updateComplete;

    const rowKeys = Array.from(sidebar.querySelectorAll("[data-session-tree]")).map((row) =>
      row.getAttribute("data-session-tree"),
    );
    expect(rowKeys[0]).toBe("agent:main:gamma");
    expect(rowFor("agent:main:alpha")).toBe(alphaBefore);
    expect(rowFor("agent:main:beta")).toBe(betaBefore);
  });
});
