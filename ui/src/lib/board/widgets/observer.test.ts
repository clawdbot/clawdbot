/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { renderObserverWidget } from "./observer.ts";

const sessionKey = "agent:main:observer-card";

function digest(
  revision: number,
  health: SessionObserverDigest["health"],
  overrides: Partial<SessionObserverDigest> = {},
): SessionObserverDigest {
  return {
    sessionKey,
    runId: "run-current",
    revision,
    updatedAt: revision * 1_000,
    headline: `Digest ${revision}`,
    health,
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("observer board card", () => {
  it("keeps superseded runs in history but resolves current status from the active run", () => {
    const previous = digest(1, "done", { runId: "run-previous", headline: "Previous done" });
    const current = [
      digest(2, "on-track"),
      digest(3, "grinding"),
      digest(4, "stuck", {
        assessment: "The repeated failure needs a different approach.",
        planProgress: { completed: 2, total: 4 },
      }),
    ];
    const digests = [previous, ...current];

    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderObserverWidget({
        observer: { activeRunId: "run-current", digests, lastReadAt: 2_500 },
      }),
      container,
    );

    expect(container.querySelector(".observer-widget__current")?.textContent).toContain("Digest 4");
    expect(container.querySelector(".observer-widget__current")?.textContent).not.toContain(
      "Previous done",
    );
    expect(container.querySelectorAll(".observer-widget__run")).toHaveLength(2);
    expect(
      [...container.querySelectorAll(".observer-widget__timeline-headline")].map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["Digest 4", "Digest 3", "Digest 2", "Previous done"]);
    expect(container.querySelectorAll('[data-transition="true"]')).toHaveLength(2);
    expect(container.textContent).toContain("2 of 4");
  });

  it("places the since-you-left divider after the newest unread block", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderObserverWidget({
        observer: {
          activeRunId: "run-current",
          digests: [digest(1, "on-track"), digest(2, "grinding"), digest(3, "stuck")],
          lastReadAt: 1_500,
        },
      }),
      container,
    );

    const boundary = container.querySelector("[data-test-id=observer-unread-boundary]");
    expect(boundary?.textContent?.trim()).toBe("Since you left");
    expect(boundary?.previousElementSibling?.textContent).toContain("Digest 2");
    expect(boundary?.nextElementSibling?.textContent).toContain("Digest 1");
  });
});
