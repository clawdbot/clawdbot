// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  controlModelArtifactPreviews,
  controlModelArtifactSourceKeys,
  mergeControlModelArtifactPreview,
} from "./chat-control-model-artifacts.ts";

describe("controlModelArtifactPreviews", () => {
  it("maps only the closed Canvas fallback and keeps source ordering evidence", () => {
    const artifacts = [
      {
        version: 1,
        id: "artifact-canvas",
        revision: 2,
        state: "ready",
        source: {
          sessionKey: "agent:main:one",
          messageId: "message-2",
          toolCallId: "tool-canvas",
          toolName: "canvas",
        },
        structuredContent: { title: "Calendar" },
        views: [
          {
            id: "native-unknown",
            templateUri: "vendor://untrusted/calendar",
            dataVersion: 1,
            availability: "inline",
          },
          {
            id: "canvas",
            templateUri: "openclaw://canvas",
            dataVersion: 1,
            availability: "inline",
            recommended: true,
            fallback: {
              kind: "canvas",
              viewId: "document-1",
              url: "/__openclaw__/canvas/documents/document-1/index.html",
              sandbox: "scripts",
            },
          },
        ],
      },
    ] as const;

    expect(
      controlModelArtifactPreviews(artifacts, [
        {
          role: "toolResult",
          messageId: "message-2",
          timestamp: 1_234,
          content: [],
        },
      ]),
    ).toEqual([
      {
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          url: "/__openclaw__/canvas/documents/document-1/index.html",
          viewId: "document-1",
          sandbox: "scripts",
        },
        text: JSON.stringify({ title: "Calendar" }),
        timestamp: 1_234,
        messageId: "message-2",
        toolCallId: "tool-canvas",
        toolName: "canvas",
      },
    ]);
  });

  it("maps MCP App fallback without selecting code from template metadata", () => {
    const artifacts = [
      {
        version: 1,
        id: "artifact-mcp",
        revision: 1,
        state: "ready",
        source: {
          sessionKey: "agent:main:one",
          toolCallId: "tool-mcp",
          toolName: "show",
        },
        views: [
          {
            id: "mcp",
            templateUri: "https://attacker.invalid/component.js",
            dataVersion: 1,
            availability: "deferred",
            fallback: {
              kind: "mcp-app",
              viewId: "mcp-view",
              uiResourceUri: "ui://demo/calendar",
            },
          },
        ],
      },
    ] as const;

    expect(controlModelArtifactPreviews(artifacts, [])[0]?.preview).toEqual({
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId: "mcp-view",
      mcpApp: {
        viewId: "mcp-view",
        uiResourceUri: "ui://demo/calendar",
        toolName: "show",
        toolCallId: "tool-mcp",
      },
    });
  });

  it("leaves unknown, failed, and source-less artifacts to incumbent fallback rendering", () => {
    const base = {
      version: 1 as const,
      revision: 1,
      source: { sessionKey: "agent:main:one", toolCallId: "tool-1" },
      views: [],
    };
    expect(
      controlModelArtifactPreviews(
        [
          { ...base, id: "unknown", state: "ready", views: [] },
          { ...base, id: "failed", state: "failed", views: [] },
          {
            ...base,
            id: "source-less",
            state: "ready",
            source: { sessionKey: "agent:main:one" },
            views: [
              {
                id: "canvas",
                templateUri: "openclaw://canvas",
                dataVersion: 1,
                availability: "inline",
                fallback: {
                  kind: "canvas",
                  url: "/__openclaw__/canvas/documents/source-less/index.html",
                  sandbox: "strict",
                },
              },
            ],
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("correlates changed renderer identities through stable message and tool provenance", () => {
    const persisted = {
      role: "toolResult",
      messageId: "message-1",
      toolCallId: "tool-1",
    };
    const live = {
      role: "toolResult",
      toolCallId: "tool-1",
    };

    expect(controlModelArtifactSourceKeys(persisted)).toEqual([
      JSON.stringify(["message-tool", "message-1", "tool-1"]),
      JSON.stringify(["tool", "tool-1"]),
    ]);
    expect(controlModelArtifactSourceKeys(live)).toEqual([JSON.stringify(["tool", "tool-1"])]);
  });

  it("lets the model replace executable identity while retaining local presentation metadata", () => {
    expect(
      mergeControlModelArtifactPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          title: "Calendar",
          preferredHeight: 480,
          viewId: "raw-view",
          url: "https://legacy.invalid/widget",
        },
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "model-view",
          url: "/__openclaw__/canvas/documents/model-view/index.html",
          sandbox: "strict",
        },
      ),
    ).toMatchObject({
      title: "Calendar",
      preferredHeight: 480,
      viewId: "model-view",
      url: "/__openclaw__/canvas/documents/model-view/index.html",
      sandbox: "strict",
    });
  });
});
