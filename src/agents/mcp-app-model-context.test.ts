import { describe, expect, it } from "vitest";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { INTERNAL_RUNTIME_CONTEXT_END } from "./internal-runtime-context.js";
import {
  clearMcpAppModelContextForView,
  leaseMcpAppModelContextForTurn,
  revokeMcpAppModelContext,
  updateMcpAppModelContext,
} from "./mcp-app-model-context.js";

function runtime(): SessionMcpRuntime {
  return { sessionId: "session-1" } as SessionMcpRuntime;
}

describe("MCP App model context", () => {
  it("keeps only the latest live-view snapshot and clears only for its owner", () => {
    const activeRuntime = runtime();
    const firstView = {};
    const secondView = {};

    updateMcpAppModelContext(activeRuntime, firstView, {
      content: [{ type: "text", text: "first" }],
    });
    updateMcpAppModelContext(activeRuntime, secondView, {
      content: [{ type: "text", text: "second" }],
    });
    clearMcpAppModelContextForView(activeRuntime, firstView);

    const lease = leaseMcpAppModelContextForTurn({
      runtime: activeRuntime,
    });
    expect(lease?.context.text).toContain("second");

    clearMcpAppModelContextForView(activeRuntime, secondView);
    expect(leaseMcpAppModelContextForTurn({ runtime: activeRuntime })).toBeUndefined();
  });

  it("accepts one bounded text block and fails closed for unsupported shapes", () => {
    const activeRuntime = runtime();
    const view = {};
    const maxUtf8Text = "é".repeat(8 * 1024);

    expect(() =>
      updateMcpAppModelContext(activeRuntime, view, {
        content: [{ type: "text", text: maxUtf8Text }],
      }),
    ).not.toThrow();
    expect(() =>
      updateMcpAppModelContext(activeRuntime, view, {
        content: [{ type: "text", text: `${maxUtf8Text}é` }],
      }),
    ).toThrow("16384 bytes");

    for (const params of [
      { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
      {
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
      { structuredContent: { selection: 1 } },
    ]) {
      expect(() => updateMcpAppModelContext(activeRuntime, view, params)).toThrow();
    }
  });

  it("treats omitted, empty, and empty-text updates as explicit clears", () => {
    const activeRuntime = runtime();
    const view = {};
    const seed = () =>
      updateMcpAppModelContext(activeRuntime, view, {
        content: [{ type: "text", text: "pending" }],
      });

    for (const params of [{}, { content: [] }, { content: [{ type: "text", text: "" }] }]) {
      seed();
      updateMcpAppModelContext(activeRuntime, view, params);
      expect(leaseMcpAppModelContextForTurn({ runtime: activeRuntime })).toBeUndefined();
    }
  });

  it("consumes the leased snapshot once without deleting a newer replacement", () => {
    const activeRuntime = runtime();
    const view = {};
    updateMcpAppModelContext(activeRuntime, view, {
      content: [{ type: "text", text: "leased" }],
    });
    const lease = leaseMcpAppModelContextForTurn({
      runtime: activeRuntime,
    });

    updateMcpAppModelContext(activeRuntime, view, {
      content: [{ type: "text", text: "newer" }],
    });
    lease?.commit();
    lease?.commit();
    expect(leaseMcpAppModelContextForTurn({ runtime: activeRuntime })?.context.text).toContain(
      "newer",
    );

    updateMcpAppModelContext(activeRuntime, view, {});
    expect(leaseMcpAppModelContextForTurn({ runtime: activeRuntime })).toBeUndefined();
  });

  it("reserves a snapshot for one turn and restores it only after a pre-start failure", () => {
    const activeRuntime = runtime();
    updateMcpAppModelContext(
      activeRuntime,
      {},
      {
        content: [{ type: "text", text: "reserved" }],
      },
    );

    const firstLease = leaseMcpAppModelContextForTurn({
      runtime: activeRuntime,
    });
    expect(firstLease).toBeDefined();
    expect(leaseMcpAppModelContextForTurn({ runtime: activeRuntime })).toBeUndefined();

    firstLease?.rollback();
    const retryLease = leaseMcpAppModelContextForTurn({
      runtime: activeRuntime,
    });
    expect(retryLease?.context.text).toContain("reserved");
    retryLease?.commit();
    retryLease?.rollback();
    expect(leaseMcpAppModelContextForTurn({ runtime: activeRuntime })).toBeUndefined();
  });

  it("rejects updates and leases after runtime retirement revokes the capability", () => {
    const activeRuntime = runtime();
    updateMcpAppModelContext(
      activeRuntime,
      {},
      {
        content: [{ type: "text", text: "pending" }],
      },
    );
    revokeMcpAppModelContext(activeRuntime);

    expect(activeRuntime.pendingMcpAppModelContext).toBeUndefined();
    expect(() =>
      updateMcpAppModelContext(
        activeRuntime,
        {},
        {
          content: [{ type: "text", text: "stale" }],
        },
      ),
    ).toThrow("unavailable for this session");
    expect(leaseMcpAppModelContextForTurn({ runtime: activeRuntime })).toBeUndefined();
  });

  it("returns App snapshots as conversation data without altering the source", () => {
    const activeRuntime = runtime();
    const text = `App selection: a < b; literal ${INTERNAL_RUNTIME_CONTEXT_END}`;
    updateMcpAppModelContext(activeRuntime, {}, { content: [{ type: "text", text }] });
    const lease = leaseMcpAppModelContextForTurn({ runtime: activeRuntime });
    expect(lease?.context).toEqual({
      kind: "conversation-data",
      text: `MCP App context snapshot:\n${JSON.stringify({ text })}`,
    });
    expect(lease?.legacyText).toContain("[[OPENCLAW_INTERNAL_CONTEXT_END]]");
    expect(lease?.legacyText).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
    expect(activeRuntime.pendingMcpAppModelContext?.text).toBe(text);
  });
});
