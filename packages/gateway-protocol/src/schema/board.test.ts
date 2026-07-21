import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  BoardActionParamsSchema,
  BoardSnapshotSchema,
  BoardWidgetAppViewParamsSchema,
  BoardWidgetAppViewResultSchema,
  BoardWidgetGrantParamsSchema,
  BoardWidgetPutParamsSchema,
  BoardWidgetResizeOpSchema,
} from "./board.js";

describe("BoardActionParamsSchema", () => {
  it("accepts both exact cron triggers and plugin action verbs", () => {
    expect(
      Value.Check(BoardActionParamsSchema, {
        ticket: "v1.ticket.signature",
        action: "cron.trigger",
        jobId: "nightly",
      }),
    ).toBe(true);
    expect(
      Value.Check(BoardActionParamsSchema, {
        ticket: "v1.ticket.signature",
        action: "workboard.dispatch",
        params: { boardId: "release" },
      }),
    ).toBe(true);
    expect(
      Value.Check(BoardActionParamsSchema, {
        ticket: "v1.ticket.signature",
        action: "workboard.dispatch",
        params: "release",
      }),
    ).toBe(false);
  });
});

describe("BoardSnapshotSchema", () => {
  it("accepts optional HTML widget view metadata", () => {
    const snapshot = {
      sessionKey: "agent:main:main",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [
        {
          name: "status",
          tabId: "main",
          contentKind: "html",
          presentation: "frameless",
          heightMode: "fixed",
          sizeW: 6,
          sizeH: 4,
          position: 0,
          grantState: "none",
          revision: 1,
          declaredSummary: ["Network access: https://example.com"],
          declared: { netOrigins: ["https://example.com"], tools: ["health"] },
          frameUrl: "/__openclaw__/board/agent%3Amain%3Amain/status/index.html?bt=ticket",
          viewTicket: "v1.ticket.signature",
          viewTicketTtlMs: 60_000,
          viewGeneration: "a".repeat(32),
          sandboxUrl: "/mcp-app-sandbox?csp=encoded",
          sandboxPort: 18790,
        },
      ],
    };
    expect(Value.Check(BoardSnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(BoardSnapshotSchema, {
        ...snapshot,
        widgets: [{ ...snapshot.widgets[0], frameUrl: 42 }],
      }),
    ).toBe(false);
    expect(
      Value.Check(BoardSnapshotSchema, {
        ...snapshot,
        widgets: [{ ...snapshot.widgets[0], presentation: "floating" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(BoardSnapshotSchema, {
        ...snapshot,
        widgets: [{ ...snapshot.widgets[0], heightMode: "elastic" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(BoardSnapshotSchema, {
        ...snapshot,
        widgets: [{ ...snapshot.widgets[0], declaredSummary: [42] }],
      }),
    ).toBe(false);
    expect(
      Value.Check(BoardSnapshotSchema, {
        ...snapshot,
        widgets: [{ ...snapshot.widgets[0], viewGeneration: "not-a-generation" }],
      }),
    ).toBe(false);
  });

  it("accepts declared grant summaries", () => {
    const widget = {
      name: "status",
      tabId: "main",
      contentKind: "mcp-app",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending",
      declaredSummary: ["Network: api.example.com", "Tools: lookup"],
      revision: 1,
    };
    const snapshot = {
      sessionKey: "agent:main:main",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [widget],
    };

    expect(Value.Check(BoardSnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(BoardSnapshotSchema, {
        ...snapshot,
        widgets: [{ ...widget, instanceId: "widget-instance" }],
      }),
    ).toBe(true);
  });
});

describe("BoardWidgetPutParamsSchema", () => {
  it("accepts a gateway-resolved canvas document source", () => {
    expect(
      Value.Check(BoardWidgetPutParamsSchema, {
        sessionKey: "agent:main:main",
        name: "status",
        content: { kind: "canvas-doc", docId: "cv_status" },
        presentation: "full-bleed",
        heightMode: "auto",
      }),
    ).toBe(true);
  });

  it("rejects invalid widget presentation and height modes", () => {
    const pin = {
      sessionKey: "agent:main:main",
      name: "status",
      content: { kind: "html", html: "<p>ok</p>" },
    };
    expect(Value.Check(BoardWidgetPutParamsSchema, { ...pin, presentation: "floating" })).toBe(
      false,
    );
    expect(Value.Check(BoardWidgetPutParamsSchema, { ...pin, heightMode: "elastic" })).toBe(false);
    expect(
      Value.Check(BoardWidgetResizeOpSchema, {
        kind: "widget_resize",
        name: "status",
        sizeW: 6,
        sizeH: 4,
        heightMode: "fixed",
      }),
    ).toBe(true);
    expect(
      Value.Check(BoardWidgetResizeOpSchema, {
        kind: "widget_resize",
        name: "status",
        sizeW: 6,
        sizeH: 4,
        heightMode: "elastic",
      }),
    ).toBe(false);
  });

  it("requires an active source view for MCP App pins", () => {
    const pin = {
      sessionKey: "agent:main:main",
      name: "weather-app",
      content: {
        kind: "mcp-app",
        viewId: "mcp-app-source",
      },
    };
    expect(Value.Check(BoardWidgetPutParamsSchema, pin)).toBe(true);
    expect(
      Value.Check(BoardWidgetPutParamsSchema, {
        ...pin,
        content: { ...pin.content, viewId: undefined },
      }),
    ).toBe(false);
    expect(
      Value.Check(BoardWidgetPutParamsSchema, {
        ...pin,
        content: {
          kind: "mcp-app",
          descriptor: { viewId: "mcp-app-source" },
        },
      }),
    ).toBe(false);
  });
});

describe("BoardWidgetAppView schemas", () => {
  it("binds lease requests to a board widget and returns its expiry", () => {
    expect(
      Value.Check(BoardWidgetAppViewParamsSchema, {
        sessionKey: "agent:main:main",
        name: "weather-app",
        revision: 3,
        instanceId: "widget-instance",
      }),
    ).toBe(true);
    expect(
      Value.Check(BoardWidgetAppViewParamsSchema, {
        sessionKey: "agent:main:main",
        name: "weather-app",
        revision: 3,
      }),
    ).toBe(false);
    expect(
      Value.Check(BoardWidgetAppViewResultSchema, {
        viewId: "mcp-app-fresh",
        expiresAtMs: 1_800_000,
      }),
    ).toBe(true);
  });
});

describe("BoardWidgetGrantParamsSchema", () => {
  it("requires the widget revision and instance being approved", () => {
    expect(
      Value.Check(BoardWidgetGrantParamsSchema, {
        sessionKey: "agent:main:main",
        name: "status",
        decision: "granted",
        revision: 1,
        instanceId: "widget-instance",
      }),
    ).toBe(true);
    expect(
      Value.Check(BoardWidgetGrantParamsSchema, {
        sessionKey: "agent:main:main",
        name: "status",
        decision: "granted",
        revision: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(BoardWidgetGrantParamsSchema, {
        sessionKey: "agent:main:main",
        name: "status",
        decision: "granted",
        instanceId: "widget-instance",
      }),
    ).toBe(false);
  });
});
