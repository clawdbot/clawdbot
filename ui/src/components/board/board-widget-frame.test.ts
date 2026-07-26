/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { BoardViewWidget } from "../../lib/board/view-types.ts";
import { BoardWidgetFrameLifecycle } from "./board-widget-frame.ts";

type LifecycleInternals = {
  sandboxOrigin: string;
  frameFailureKey: string;
  frameRefreshAttempts: number;
  refreshFailedFrame: (widget: BoardViewWidget) => void;
};

// Drives the private terminal-failure path directly: attempts are exhausted so
// refreshFailedFrame surfaces the terminal message for the given sandbox origin.
function terminalFailureError(params: {
  widget: Partial<BoardViewWidget>;
  resolvedSandboxOrigin: string;
}): string {
  const widget = { name: "clock", revision: 1, ...params.widget } as BoardViewWidget;
  const lifecycle = new BoardWidgetFrameLifecycle({
    connected: () => true,
    context: () => undefined,
    refreshFrame: () => undefined,
    reportContentHeight: () => {},
    requestUpdate: () => {},
    resolveFrameUrl: () => () => "",
    root: () => document,
    widget: () => widget,
  });
  const internals = lifecycle as unknown as LifecycleInternals;
  internals.sandboxOrigin = params.resolvedSandboxOrigin;
  internals.frameFailureKey = `${widget.name}:${widget.revision}`;
  internals.frameRefreshAttempts = 3;
  internals.refreshFailedFrame(widget);
  return lifecycle.error;
}

describe("board widget frame terminal failure message", () => {
  it("points at mcp.apps.sandboxOrigin when a derived remote sandbox origin fails", () => {
    const message = terminalFailureError({
      widget: {},
      resolvedSandboxOrigin: "https://team.example.com:18790",
    });
    expect(message).toContain("mcp.apps.sandboxOrigin");
  });

  it("keeps the authorization message when a sandbox origin is explicitly configured", () => {
    const message = terminalFailureError({
      widget: { sandboxOrigin: "https://widgets.example.com" },
      resolvedSandboxOrigin: "https://widgets.example.com",
    });
    expect(message).toContain("authorization failed");
    expect(message).not.toContain("mcp.apps.sandboxOrigin");
  });

  it("keeps the authorization message for loopback sandbox hosts", () => {
    for (const origin of [
      "http://localhost:18790",
      "http://127.0.0.1:18790",
      "http://[::1]:18790",
    ]) {
      const message = terminalFailureError({ widget: {}, resolvedSandboxOrigin: origin });
      expect(message).toContain("authorization failed");
      expect(message).not.toContain("mcp.apps.sandboxOrigin");
    }
  });

  it("keeps the authorization message when no sandbox origin was resolved", () => {
    const message = terminalFailureError({ widget: {}, resolvedSandboxOrigin: "" });
    expect(message).toContain("authorization failed");
    expect(message).not.toContain("mcp.apps.sandboxOrigin");
  });
});
