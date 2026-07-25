import { describe, expect, it } from "vitest";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { withObserverWidget } from "./observer-dashboard.ts";
import type { BoardSnapshot } from "./types.ts";

const snapshot: BoardSnapshot = {
  sessionKey: "agent:main:observer-board",
  revision: 7,
  tabs: [],
  widgets: [],
};

const digest: SessionObserverDigest = {
  sessionKey: snapshot.sessionKey,
  runId: "run-1",
  revision: 1,
  updatedAt: 1_000,
  headline: "Reviewing the focused test",
  health: "on-track",
};

describe("observer dashboard injection", () => {
  it("leaves a board without observer digests unchanged", () => {
    expect(withObserverWidget(snapshot, [])).toBe(snapshot);
  });

  it("adds one ephemeral read-only board tab and card when digest history exists", () => {
    const projected = withObserverWidget(snapshot, [digest]);

    expect(projected).not.toBe(snapshot);
    expect(snapshot.tabs).toEqual([]);
    expect(snapshot.widgets).toEqual([]);
    expect(projected.tabs).toEqual([
      expect.objectContaining({ tabId: "builtin-observer", title: "Session observer" }),
    ]);
    expect(projected.widgets).toEqual([
      expect.objectContaining({
        name: "builtin:observer",
        builtin: "observer",
        contentKind: "builtin",
        readOnly: true,
        grantState: "granted",
      }),
    ]);
  });

  it("replaces its view projection instead of duplicating the card", () => {
    const first = withObserverWidget(snapshot, [digest]);
    const second = withObserverWidget(first, [{ ...digest, revision: 2, updatedAt: 2_000 }]);

    expect(second.tabs.filter((tab) => tab.tabId === "builtin-observer")).toHaveLength(1);
    expect(second.widgets.filter((widget) => widget.name === "builtin:observer")).toHaveLength(1);
  });
});
