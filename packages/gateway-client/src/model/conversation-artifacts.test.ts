import { describe, expect, it, vi } from "vitest";
import { collectMessageUiArtifacts, reconcileUiArtifacts } from "./artifact-projection.js";
import {
  activatedConversation,
  createHarness,
  flush,
  message,
} from "./conversation.test-support.js";

function uiArtifact(
  revision = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    id: "artifact-calendar",
    revision,
    structuredContent: { title: "Team calendar" },
    views: [
      {
        id: "calendar",
        templateUri: "clawpilot://widgets/calendar",
        dataVersion: 1,
        availability: "inline",
        data: { events: [] },
      },
    ],
    state: "ready",
    source: {
      sessionKey: "agent:main:one",
      messageId: "message-2",
      toolCallId: "tool-calendar",
      toolName: "calendar",
    },
    ...overrides,
  };
}

function artifactHistory(artifact: unknown) {
  return {
    messages: [
      {
        ...message(2),
        role: "toolResult",
        toolCallId: "tool-calendar",
        toolName: "calendar",
        details: { uiArtifacts: [artifact] },
      },
    ],
    completeSnapshot: true,
  };
}

describe("Control Model conversation artifacts", () => {
  it("projects canonical artifacts and associates trusted provenance", async () => {
    const artifact = uiArtifact(1, {
      views: [
        {
          id: "calendar",
          templateUri: "clawpilot://widgets/calendar",
          dataVersion: 1,
          availability: "inline",
          data: { events: [] },
        },
        {
          id: "unknown",
          templateUri: "custom-view://vendor/unknown",
          dataVersion: 1,
          availability: "deferred",
          module: "https://attacker.invalid/component.js",
        },
      ],
      module: "https://attacker.invalid/component.js",
      registerComponent: "calendar",
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      { history: artifactHistory(artifact) },
    );
    const { model, conversation } = await activatedConversation(harness);

    await vi.waitFor(() => expect(conversation.getSnapshot().artifacts).toHaveLength(1));
    expect(conversation.getSnapshot().artifacts[0]).toMatchObject({
      id: "artifact-calendar",
      revision: 1,
      source: { messageId: "message-2", toolCallId: "tool-calendar" },
      views: [
        { templateUri: "clawpilot://widgets/calendar" },
        { templateUri: "custom-view://vendor/unknown" },
      ],
    });
    expect(conversation.getSnapshot().artifacts[0]).not.toHaveProperty("module");
    expect(conversation.getSnapshot().messages[0]?.artifactIds).toEqual(["artifact-calendar"]);
    model.dispose();
  });

  it("keeps prototype-sensitive JSON keys as inert snapshot data", async () => {
    const artifact = uiArtifact(1, {
      structuredContent: JSON.parse('{"__proto__":{"polluted":true}}'),
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      { history: artifactHistory(artifact) },
    );
    const { model, conversation } = await activatedConversation(harness);

    const structuredContent = conversation.getSnapshot().artifacts[0]?.structuredContent;
    expect(Object.getPrototypeOf(structuredContent)).toBe(Object.prototype);
    expect(Object.hasOwn(structuredContent as object, "__proto__")).toBe(true);
    expect(Reflect.get(structuredContent as object, "__proto__")).toEqual({ polluted: true });
    expect((structuredContent as Record<string, unknown>).polluted).toBeUndefined();
    model.dispose();
  });

  it("reconciles live artifacts into persisted provenance and rejects forged source claims", async () => {
    const { harness, model, conversation } = await activatedConversation();
    const artifact = uiArtifact(1, {
      source: {
        sessionKey: "agent:main:one",
        messageId: "forged-message",
        toolCallId: "forged-tool",
        toolName: "forged-name",
      },
    });
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-artifact",
        stream: "tool",
        data: {
          phase: "result",
          toolName: "calendar",
          uiArtifacts: [artifact],
        },
      },
    });
    expect(conversation.getSnapshot().artifacts[0]?.source).toEqual({
      sessionKey: "agent:main:one",
      toolName: "calendar",
    });

    harness.emit({
      event: "session.message",
      payload: {
        sessionKey: "agent:main:one",
        message: {
          ...message(2),
          role: "toolResult",
          toolCallId: "tool-calendar",
          toolName: "calendar",
          details: { uiArtifacts: [artifact] },
        },
      },
    });
    expect(conversation.getSnapshot().artifacts[0]?.source).toEqual({
      sessionKey: "agent:main:one",
      messageId: "message-2",
      toolCallId: "tool-calendar",
      toolName: "calendar",
    });
    expect(conversation.getSnapshot().messages.at(-1)?.artifactIds).toEqual(["artifact-calendar"]);
    model.dispose();
  });

  it("accepts artifact provenance from the acknowledged canonical session alias", async () => {
    const artifact = uiArtifact(1, {
      source: {
        sessionKey: "one",
        messageId: "message-2",
        toolCallId: "tool-calendar",
        toolName: "calendar",
      },
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        history: artifactHistory(artifact),
        keysEquivalent: (left, right) =>
          left.replace("agent:main:", "") === right.replace("agent:main:", ""),
      },
    );
    harness.queue("sessions.messages.subscribe", { key: "one" });
    const { model, conversation } = await activatedConversation(harness);

    await vi.waitFor(() => expect(conversation.getSnapshot().artifacts).toHaveLength(1));
    expect(conversation.getSnapshot().artifacts[0]).toMatchObject({
      id: "artifact-calendar",
      state: "ready",
      source: { sessionKey: "agent:main:one" },
    });
    model.dispose();
  });

  it("does not let a persisted live duplicate evict newer history", async () => {
    const { harness, model, conversation } = await activatedConversation(undefined, {
      maxConversationArtifacts: 1,
    });
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-old",
        stream: "tool",
        data: {
          phase: "result",
          uiArtifacts: [uiArtifact(1, { id: "artifact-old" })],
        },
      },
    });
    harness.emit({
      event: "session.message",
      payload: {
        sessionKey: "agent:main:one",
        message: {
          ...message(1),
          role: "toolResult",
          details: { uiArtifacts: [uiArtifact(1, { id: "artifact-old" })] },
        },
      },
    });
    harness.emit({
      event: "session.message",
      payload: {
        sessionKey: "agent:main:one",
        message: {
          ...message(2),
          role: "toolResult",
          details: { uiArtifacts: [uiArtifact(1, { id: "artifact-new" })] },
        },
      },
    });

    expect(conversation.getSnapshot().artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-new",
    ]);
    model.dispose();
  });

  it("retires materialized data on disconnect and every epoch replacement", async () => {
    const artifact = uiArtifact(4, {
      views: [
        {
          id: "list",
          templateUri: "clawpilot://widgets/list",
          dataVersion: 1,
          availability: "deferred",
        },
      ],
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      { history: artifactHistory(artifact) },
    );
    const { model, conversation } = await activatedConversation(harness);
    const materialized = (row: string) => ({
      artifactId: "artifact-calendar",
      artifactRevision: 4,
      view: {
        id: "list",
        templateUri: "clawpilot://widgets/list",
        dataVersion: 1,
        availability: "inline",
        data: { rows: [{ id: row }] },
      },
    });
    const request = {
      artifactId: "artifact-calendar",
      artifactRevision: 4,
      viewId: "list",
    };

    harness.queue("artifact.materialize", materialized("epoch-1"));
    await expect(conversation.materializeView(request)).resolves.toMatchObject({
      data: { rows: [{ id: "epoch-1" }] },
    });
    expect(conversation.getSnapshot().artifacts[0]?.views[0]).toMatchObject({
      availability: "inline",
      data: { rows: [{ id: "epoch-1" }] },
    });

    harness.setConnection({ status: "disconnected", epoch: 1 });
    expect(conversation.getSnapshot().artifacts[0]?.views[0]).toMatchObject({
      availability: "deferred",
    });
    expect(conversation.getSnapshot().artifacts[0]?.views[0]).not.toHaveProperty("data");

    harness.setHistory(0, artifactHistory(artifact));
    harness.setConnection({ status: "connected", epoch: 2 });
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(2));
    expect(conversation.getSnapshot().artifacts[0]?.views[0]).toMatchObject({
      availability: "deferred",
    });
    expect(harness.callsFor("artifact.materialize")).toHaveLength(1);

    harness.queue("artifact.materialize", materialized("epoch-2"));
    await expect(conversation.materializeView(request)).resolves.toMatchObject({
      data: { rows: [{ id: "epoch-2" }] },
    });
    expect(harness.callsFor("artifact.materialize")).toHaveLength(2);

    harness.setHistory(0, artifactHistory(artifact));
    harness.setConnection({ status: "connected", epoch: 3 });
    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(3));
    expect(conversation.getSnapshot().artifacts[0]?.views[0]).toMatchObject({
      availability: "deferred",
    });
    expect(conversation.getSnapshot().artifacts[0]?.views[0]).not.toHaveProperty("data");
    expect(harness.callsFor("artifact.materialize")).toHaveLength(2);
    model.dispose();
  });

  it("retires live and materialized artifacts when the session resets", async () => {
    const deferred = uiArtifact(1, {
      views: [
        {
          id: "list",
          templateUri: "clawpilot://widgets/list",
          dataVersion: 1,
          availability: "deferred",
        },
      ],
    });
    const { harness, model, conversation } = await activatedConversation();
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-artifact",
        stream: "tool",
        data: { phase: "result", uiArtifacts: [deferred] },
      },
    });
    harness.queue("artifact.materialize", {
      artifactId: "artifact-calendar",
      artifactRevision: 1,
      view: {
        id: "list",
        templateUri: "clawpilot://widgets/list",
        dataVersion: 1,
        availability: "inline",
        data: { rows: [] },
      },
    });
    await conversation.materializeView({
      artifactId: "artifact-calendar",
      artifactRevision: 1,
      viewId: "list",
    });
    expect(conversation.getSnapshot().artifacts).toHaveLength(1);

    harness.emit({
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:one", reason: "reset" },
    });

    expect(conversation.getSnapshot().artifacts).toEqual([]);
    model.dispose();
  });

  it("rejects in-flight materialization that crosses a session reset", async () => {
    const deferred = uiArtifact(1, {
      views: [
        {
          id: "list",
          templateUri: "clawpilot://widgets/list",
          dataVersion: 1,
          availability: "deferred",
        },
      ],
    });
    const { harness, model, conversation } = await activatedConversation();
    const emitArtifact = () =>
      harness.emit({
        event: "agent",
        payload: {
          sessionKey: "agent:main:one",
          runId: "run-artifact",
          stream: "tool",
          data: { phase: "result", uiArtifacts: [deferred] },
        },
      });
    emitArtifact();
    const response = harness.defer("artifact.materialize");
    const materializing = conversation.materializeView({
      artifactId: "artifact-calendar",
      artifactRevision: 1,
      viewId: "list",
    });
    await flush();

    harness.emit({
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:one", reason: "reset" },
    });
    emitArtifact();
    response.resolve({
      artifactId: "artifact-calendar",
      artifactRevision: 1,
      view: {
        id: "list",
        templateUri: "clawpilot://widgets/list",
        dataVersion: 1,
        availability: "inline",
        data: { rows: [] },
      },
    });

    await expect(materializing).rejects.toMatchObject({ code: "STALE_ARTIFACT_VIEW" });
    expect(conversation.getSnapshot().artifacts[0]?.views[0]).toMatchObject({
      availability: "deferred",
    });
    model.dispose();
  });

  it("does not restore pre-reset artifacts from an in-flight history response", async () => {
    const harness = createHarness({ status: "connected", epoch: 1 });
    const staleHistory = harness.defer("chat.history");
    const { model, conversation } = await activatedConversation(harness);

    harness.emit({
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:one", reason: "reset" },
    });
    harness.queue("chat.history", {
      messages: [],
      completeSnapshot: true,
      totalMessages: 0,
    });
    staleHistory.resolve(artifactHistory(uiArtifact()));

    await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(2));
    await vi.waitFor(() => expect(conversation.getSnapshot().history.status).toBe("ready"));
    expect(conversation.getSnapshot().artifacts).toEqual([]);
    model.dispose();
  });

  it("rejects a selected view invalidated during materialization", async () => {
    const artifact = uiArtifact(4, {
      views: [
        {
          id: "calendar",
          templateUri: "clawpilot://widgets/calendar",
          dataVersion: 1,
          availability: "deferred",
        },
      ],
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      { history: artifactHistory(artifact) },
    );
    const { model, conversation } = await activatedConversation(harness);
    const response = harness.defer("artifact.materialize");
    const materializing = conversation.materializeView({
      artifactId: "artifact-calendar",
      artifactRevision: 4,
      viewId: "calendar",
    });
    await flush();
    harness.emit({
      event: "agent",
      payload: {
        sessionKey: "agent:main:one",
        runId: "run-conflict",
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "tool-calendar",
          uiArtifacts: [uiArtifact(4, { structuredContent: { title: "conflict" } })],
        },
      },
    });
    response.resolve({
      artifactId: "artifact-calendar",
      artifactRevision: 4,
      view: {
        id: "calendar",
        templateUri: "clawpilot://widgets/calendar",
        dataVersion: 1,
        availability: "inline",
        data: { events: [] },
      },
    });

    await expect(materializing).rejects.toMatchObject({ code: "STALE_ARTIFACT_VIEW" });
    expect(conversation.getSnapshot().artifacts[0]).toMatchObject({
      state: "failed",
      error: { code: "ARTIFACT_REVISION_CONFLICT" },
    });
    model.dispose();
  });

  it("bounds materialized data across the complete artifact", async () => {
    const artifact = uiArtifact(5, {
      views: [
        {
          id: "first",
          templateUri: "clawpilot://widgets/list",
          dataVersion: 1,
          availability: "deferred",
        },
        {
          id: "second",
          templateUri: "clawpilot://widgets/list",
          dataVersion: 1,
          availability: "deferred",
        },
      ],
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      { history: artifactHistory(artifact) },
    );
    const { model, conversation } = await activatedConversation(harness, {
      maxArtifactBytes: 900,
    });
    const materialized = (viewId: string) => ({
      artifactId: "artifact-calendar",
      artifactRevision: 5,
      view: {
        id: viewId,
        templateUri: "clawpilot://widgets/list",
        dataVersion: 1,
        availability: "inline",
        data: { value: "x".repeat(350) },
      },
    });

    harness.queue("artifact.materialize", materialized("first"));
    await expect(
      conversation.materializeView({
        artifactId: "artifact-calendar",
        artifactRevision: 5,
        viewId: "first",
      }),
    ).resolves.toMatchObject({ availability: "inline" });

    harness.queue("artifact.materialize", materialized("second"));
    await expect(
      conversation.materializeView({
        artifactId: "artifact-calendar",
        artifactRevision: 5,
        viewId: "second",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_MATERIALIZATION_EXCEEDS_BOUNDS" });
    expect(conversation.getSnapshot().artifacts[0]?.views[1]).toMatchObject({
      availability: "deferred",
    });
    model.dispose();
  });

  it("retains the newest distinct history artifact regardless of revision", async () => {
    const history = {
      messages: [
        {
          ...message(1),
          role: "toolResult",
          details: { uiArtifacts: [uiArtifact(100, { id: "artifact-old" })] },
        },
        {
          ...message(2),
          role: "toolResult",
          details: { uiArtifacts: [uiArtifact(1, { id: "artifact-new" })] },
        },
      ],
      completeSnapshot: true,
    };
    const harness = createHarness({ status: "connected", epoch: 1 }, { history });
    const { model, conversation } = await activatedConversation(harness, {
      maxConversationArtifacts: 1,
    });

    await vi.waitFor(() =>
      expect(conversation.getSnapshot().artifacts.map((artifact) => artifact.id)).toEqual([
        "artifact-new",
      ]),
    );
    model.dispose();
  });

  it("adapts MCP App metadata, contains malformed artifacts, and bounds candidates", async () => {
    const malformed = uiArtifact(1, {
      id: "artifact-malformed",
      structuredContent: { invalid: () => undefined },
    });
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      {
        history: {
          messages: [
            {
              ...message(2),
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "show",
              details: {
                structuredContent: { title: "MCP result" },
                mcpAppPreview: {
                  kind: "canvas",
                  view: { id: "mcp-app-view" },
                  mcpApp: {
                    viewId: "mcp-app-view",
                    uiResourceUri: "ui://demo/calendar",
                    toolCallId: "call-1",
                  },
                },
                uiArtifacts: [malformed],
              },
            },
          ],
          completeSnapshot: true,
        },
      },
    );
    const { model, conversation } = await activatedConversation(harness);

    await vi.waitFor(() => expect(conversation.getSnapshot().artifacts).toHaveLength(2));
    expect(conversation.getSnapshot().artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "artifact-malformed",
          state: "failed",
          error: expect.objectContaining({ code: "ARTIFACT_MALFORMED" }),
        }),
        expect.objectContaining({
          id: "mcp-app:call-1",
          structuredContent: { title: "MCP result" },
          views: [
            expect.objectContaining({
              templateUri: "ui://demo/calendar",
              availability: "inline",
              fallback: {
                kind: "mcp-app",
                viewId: "mcp-app-view",
                uiResourceUri: "ui://demo/calendar",
              },
            }),
          ],
        }),
      ]),
    );

    const bounded = collectMessageUiArtifacts(
      {
        details: {
          uiArtifacts: Array.from({ length: 20 }, (_, index) =>
            uiArtifact(index + 1, { id: `artifact-${index + 1}` }),
          ),
        },
      },
      { sessionKey: "agent:main:one", messageId: "message-bounded" },
      {
        maxArtifacts: 2,
        maxBytes: 64_000,
        maxDepth: 12,
        maxCollectionItems: 256,
        maxStringBytes: 16_000,
        maxViews: 16,
      },
      3,
    );
    expect(bounded.map((artifact) => artifact.id)).toEqual([
      "artifact-1",
      "artifact-2",
      "artifact-3",
    ]);
    expect(
      collectMessageUiArtifacts(
        { details: { uiArtifacts: [uiArtifact()] } },
        {
          sessionKey: "agent:main:one",
          messageId: "message-bounded",
          toolCallId: "x".repeat(5_000),
        },
        {
          maxArtifacts: 2,
          maxBytes: 256,
          maxDepth: 12,
          maxCollectionItems: 256,
          maxStringBytes: 128,
          maxViews: 16,
        },
      ),
    ).toEqual([]);

    const reconciliationBounds = {
      maxArtifacts: 1,
      maxBytes: 64_000,
      maxDepth: 12,
      maxCollectionItems: 256,
      maxStringBytes: 16_000,
      maxViews: 16,
    };
    const recencyCandidates = collectMessageUiArtifacts(
      {
        details: {
          uiArtifacts: [
            uiArtifact(100, { id: "artifact-old" }),
            uiArtifact(1, { id: "artifact-new" }),
          ],
        },
      },
      { sessionKey: "agent:main:one", messageId: "message-recency" },
      reconciliationBounds,
      2,
    );
    const reconciled = reconcileUiArtifacts(recencyCandidates, reconciliationBounds);
    expect(reconciled.map((artifact) => artifact.id)).toEqual(["artifact-new"]);
    const staleDuplicate = collectMessageUiArtifacts(
      {
        details: {
          uiArtifacts: [
            uiArtifact(2, { id: "artifact-old" }),
            uiArtifact(1, { id: "artifact-new" }),
            uiArtifact(1, { id: "artifact-old" }),
          ],
        },
      },
      { sessionKey: "agent:main:one", messageId: "message-stale" },
      reconciliationBounds,
      3,
    );
    expect(
      reconcileUiArtifacts(staleDuplicate, reconciliationBounds).map((artifact) => artifact.id),
    ).toEqual(["artifact-new"]);
    model.dispose();
  });
});
