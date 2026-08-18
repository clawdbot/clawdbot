// Qa Lab UI render tests cover evidence gallery affordances.
import { describe, expect, it } from "vitest";
import { renderQaLabUi, type UiState } from "./ui-render.js";

function evidenceState(overrides: Partial<UiState> = {}): UiState {
  return {
    activeTab: "evidence",
    bootstrap: null,
    busy: false,
    captureCollapsedLaneIds: [],
    captureControlsExpanded: true,
    captureCoverage: null,
    captureDetailPlacement: "right",
    captureDetailSplitDragging: false,
    captureDetailSplitPct: 35,
    captureDetailView: "overview",
    captureErrorsOnly: false,
    captureEvents: [],
    captureFlowDetailLayout: null,
    captureGroupMode: "none",
    captureHeaderMode: "key",
    captureHostFilter: [],
    captureKindFilter: [],
    capturePayloadDetailLayout: null,
    capturePayloadEventFilter: "",
    capturePayloadEventSort: "stream",
    capturePayloadExtent: "preview",
    capturePinnedLaneIds: [],
    capturePreferredDetailView: null,
    captureProviderFilter: [],
    captureQueryPreset: "none",
    captureQueryRows: [],
    captureSavedViews: [],
    captureSearchText: "",
    captureSelectedSessionsExpanded: true,
    captureSessions: [],
    captureStartupStatus: null,
    captureSummaryExpanded: true,
    captureTimelineBrushAnchorPct: null,
    captureTimelineBrushCurrentPct: null,
    captureTimelineFocusSelectedFlow: false,
    captureTimelineFocusedLaneMode: "all",
    captureTimelineFocusedLaneThreshold: "any",
    captureTimelineLaneMode: "domain",
    captureTimelineLaneSearch: "",
    captureTimelineLaneSort: "most-events",
    captureTimelinePreviousLaneSort: null,
    captureTimelineSparklineMode: "session-relative",
    captureTimelineWindowEndPct: null,
    captureTimelineWindowStartPct: null,
    captureTimelineZoom: 100,
    captureViewMode: "list",
    composer: {
      conversationId: "",
      conversationKind: "direct",
      senderId: "",
      senderName: "",
      text: "",
    },
    error: null,
    evidence: null,
    evidenceArtifactFilter: "all",
    evidenceError: null,
    evidenceLoading: false,
    evidencePathDraft: "",
    evidenceSearchText: "",
    evidenceStatusFilter: "all",
    latestReport: null,
    runnerDraft: null,
    runnerDraftDirty: false,
    runnerPlanOverride: null,
    scenarioRun: null,
    selectedCaptureEventKey: null,
    selectedCaptureSessionIds: [],
    selectedConversationKey: null,
    selectedEvidenceEntryId: null,
    selectedScenarioId: null,
    selectedThreadId: null,
    sidebarCollapsed: false,
    sidebarPanel: "scenarios",
    snapshot: null,
    theme: "light",
    ...overrides,
  };
}

describe("QA Lab UI evidence render", () => {
  it("keeps same-id conversations isolated by account and kind", () => {
    const selectedConversationKey = JSON.stringify(["account-a", "channel", "shared"]);
    const html = renderQaLabUi(
      evidenceState({
        activeTab: "chat",
        selectedConversationKey,
        snapshot: {
          conversations: [
            { accountId: "account-a", id: "shared", kind: "channel" },
            { accountId: "account-b", id: "shared", kind: "channel" },
            { accountId: "account-a", id: "shared", kind: "direct" },
          ],
          cursor: 0,
          events: [],
          messages: [
            {
              accountId: "account-a",
              conversation: { id: "shared", kind: "channel" },
              direction: "outbound",
              id: "selected-message",
              reactions: [],
              senderId: "openclaw",
              text: "selected account message",
              timestamp: 1,
            },
            {
              accountId: "account-b",
              conversation: { id: "shared", kind: "channel" },
              direction: "outbound",
              id: "foreign-account-message",
              reactions: [],
              senderId: "openclaw",
              text: "foreign account message",
              timestamp: 2,
            },
            {
              accountId: "account-a",
              conversation: { id: "shared", kind: "direct" },
              direction: "outbound",
              id: "foreign-kind-message",
              reactions: [],
              senderId: "openclaw",
              text: "foreign kind message",
              timestamp: 3,
            },
          ],
          threads: [
            {
              accountId: "account-a",
              conversationId: "shared",
              createdAt: 0,
              createdBy: "openclaw",
              id: "selected-thread",
              title: "Selected thread",
            },
            {
              accountId: "account-b",
              conversationId: "shared",
              createdAt: 0,
              createdBy: "openclaw",
              id: "foreign-thread",
              title: "Foreign thread",
            },
          ],
        },
      }),
    );

    expect(html).toContain("selected account message");
    expect(html).toContain("Selected thread");
    expect(html).not.toContain("foreign account message");
    expect(html).not.toContain("foreign kind message");
    expect(html).not.toContain("Foreign thread");
    expect(html).toContain("shared (account-a)");
    expect(html).toContain("shared (account-b)");
    expect(html).toContain(
      `data-conversation-key="${selectedConversationKey.replaceAll('"', "&quot;")}"`,
    );

    const crossAccountKindHtml = renderQaLabUi(
      evidenceState({
        activeTab: "chat",
        snapshot: {
          conversations: [
            { accountId: "account-a", id: "shared", kind: "group" },
            { accountId: "account-b", id: "shared", kind: "channel" },
          ],
          cursor: 0,
          events: [],
          messages: [],
          threads: [],
        },
      }),
    );
    expect(crossAccountKindHtml).toContain("shared (group, account-a)");
    expect(crossAccountKindHtml).toContain("shared (channel, account-b)");
  });

  it("shows group conversations in the sidebar and composer without leaking same-id rooms", () => {
    const selectedConversationKey = JSON.stringify(["account-a", "group", "shared"]);
    const html = renderQaLabUi(
      evidenceState({
        activeTab: "chat",
        selectedConversationKey,
        composer: {
          conversationId: "shared",
          conversationKind: "group",
          senderId: "alice",
          senderName: "Alice",
          text: "",
        },
        snapshot: {
          conversations: [
            { accountId: "account-a", id: "shared", kind: "group" },
            { accountId: "account-b", id: "shared", kind: "group" },
            { accountId: "account-a", id: "shared", kind: "channel" },
            { accountId: "account-a", id: "shared", kind: "direct" },
          ],
          cursor: 0,
          events: [],
          messages: [
            {
              accountId: "account-a",
              conversation: { id: "shared", kind: "group" },
              direction: "inbound",
              id: "selected-group-message",
              reactions: [],
              senderId: "alice",
              text: "selected group message",
              timestamp: 1,
            },
            {
              accountId: "account-b",
              conversation: { id: "shared", kind: "group" },
              direction: "inbound",
              id: "foreign-group-message",
              reactions: [],
              senderId: "bob",
              text: "foreign group message",
              timestamp: 2,
            },
            {
              accountId: "account-a",
              conversation: { id: "shared", kind: "channel" },
              direction: "outbound",
              id: "same-id-channel-message",
              reactions: [],
              senderId: "openclaw",
              text: "same-id channel message",
              timestamp: 3,
            },
          ],
          threads: [],
        },
      }),
    );

    expect(html).toContain("shared (group, account-a)");
    expect(html).toContain("shared (group, account-b)");
    expect(html).toContain("shared (channel, account-a)");
    expect(html).toContain("selected group message");
    expect(html).not.toContain("foreign group message");
    expect(html).not.toContain("same-id channel message");
    expect(html).toContain('<option value="group" selected>Group</option>');
    expect(html).toContain(
      `data-conversation-key="${selectedConversationKey.replaceAll('"', "&quot;")}"`,
    );
  });

  it("keeps thread replies out of the root timeline when thread navigation exists", () => {
    const selectedConversationKey = JSON.stringify(["default", "channel", "qa-room"]);
    const snapshot: NonNullable<UiState["snapshot"]> = {
      conversations: [{ accountId: "default", id: "qa-room", kind: "channel" }],
      cursor: 0,
      events: [],
      messages: [
        {
          accountId: "default",
          conversation: { id: "qa-room", kind: "channel" },
          direction: "outbound",
          id: "root-message",
          reactions: [],
          senderId: "openclaw",
          text: "root timeline message",
          timestamp: 1,
        },
        {
          accountId: "default",
          conversation: { id: "qa-room", kind: "channel" },
          direction: "outbound",
          id: "thread-message",
          reactions: [],
          senderId: "openclaw",
          text: "thread-only reply",
          threadId: "owned-thread",
          timestamp: 2,
        },
        {
          accountId: "default",
          conversation: { id: "qa-room", kind: "channel" },
          direction: "outbound",
          id: "external-thread-message",
          reactions: [],
          senderId: "openclaw",
          text: "externally observed thread reply",
          threadId: "external-thread",
          timestamp: 3,
        },
      ],
      threads: [
        {
          accountId: "default",
          conversationId: "qa-room",
          createdAt: 0,
          createdBy: "openclaw",
          id: "owned-thread",
          title: "Owned thread",
        },
      ],
    };

    const rootHtml = renderQaLabUi(
      evidenceState({ activeTab: "chat", selectedConversationKey, snapshot }),
    );
    expect(rootHtml).toContain("Main timeline");
    expect(rootHtml).toContain("root timeline message");
    expect(rootHtml).not.toContain("thread-only reply");
    expect(rootHtml).toContain("externally observed thread reply");

    const threadHtml = renderQaLabUi(
      evidenceState({
        activeTab: "chat",
        selectedConversationKey,
        selectedThreadId: "owned-thread",
        snapshot,
      }),
    );
    expect(threadHtml).not.toContain("root timeline message");
    expect(threadHtml).toContain("thread-only reply");
    expect(threadHtml).not.toContain("externally observed thread reply");

    const externalThreadHtml = renderQaLabUi(
      evidenceState({
        activeTab: "chat",
        selectedConversationKey,
        snapshot: { ...snapshot, threads: [] },
      }),
    );
    expect(externalThreadHtml).toContain("thread-only reply");
  });

  it("renders capture startup commands without personal home paths", () => {
    const html = renderQaLabUi(evidenceState({ activeTab: "capture" }));

    expect(html).toContain("$HOME/.openclaw/debug-proxy/certs/root-ca.pem");
    expect(html).not.toContain("/Users/");
  });

  it("maps blocked and skipped evidence statuses to styled tones", () => {
    const html = renderQaLabUi(
      evidenceState({
        evidence: {
          counts: { blocked: 1, fail: 0, pass: 0, skipped: 1 },
          entries: [
            {
              artifacts: [],
              coverage: [{ id: "qa.blocked", role: "primary" }],
              failureReason: "Environment unavailable",
              id: "qa-lab.blocked",
              kind: "script-test",
              sourcePath: "scripts/blocked.ts",
              status: "blocked",
              title: "Blocked evidence",
            },
            {
              artifacts: [],
              coverage: [{ id: "qa.skipped", role: "primary" }],
              failureReason: null,
              id: "qa-lab.skipped",
              kind: "vitest-test",
              sourcePath: "extensions/qa-lab/src/skipped.test.ts",
              status: "skipped",
              title: "Skipped evidence",
            },
          ],
          evidenceMode: "full",
          evidencePath: ".artifacts/qa-e2e/suite/qa-evidence.json",
          generatedAt: "2026-06-17T12:00:00.000Z",
          producerContext: null,
          profile: null,
          schemaVersion: 2,
        },
        selectedEvidenceEntryId: "qa-lab.blocked",
      }),
    );

    expect(html).toContain("badge-pending");
    expect(html).toContain("badge-skip");
    expect(html).toContain("scenario-item-dot-pending");
    expect(html).toContain("scenario-item-dot-skip");
    expect(html).not.toContain("badge-blocked");
    expect(html).not.toContain("badge-skipped");
    expect(html).not.toContain("scenario-item-dot-blocked");
  });

  it("links executed UX Matrix cells to evidence entries and leaves proof gaps unlinked", () => {
    const html = renderQaLabUi(
      evidenceState({
        evidence: {
          counts: { blocked: 0, fail: 0, pass: 1, skipped: 0 },
          entries: [
            {
              artifacts: [
                {
                  error: null,
                  exists: true,
                  href: "/api/evidence/artifact?artifactPath=screenshot.png",
                  kind: "screenshot",
                  mediaKind: "image",
                  path: "screenshot.png",
                  preview: null,
                  source: "ux-matrix:web-ui:first-run",
                },
                {
                  error: null,
                  exists: true,
                  href: "/api/evidence/artifact?artifactPath=recording.gif",
                  kind: "motion-preview-gif",
                  mediaKind: "image",
                  path: "recording.gif",
                  preview: null,
                  source: "ux-matrix:web-ui:first-run",
                },
                {
                  error: null,
                  exists: true,
                  href: "/api/evidence/artifact?artifactPath=recording.webm",
                  kind: "video",
                  mediaKind: "video",
                  path: "recording.webm",
                  preview: null,
                  source: "ux-matrix:web-ui:first-run",
                },
              ],
              coverage: [],
              failureReason: null,
              id: "ux-matrix.web-ui.first-run",
              kind: "ux-matrix-cell",
              sourcePath: "scripts/ux-matrix/dashboard.ts",
              status: "pass",
              title: "UX Matrix: web-ui / first-run",
            },
          ],
          evidenceMode: "full",
          evidencePath: ".artifacts/qa-e2e/suite/qa-evidence.json",
          generatedAt: "2026-06-17T12:00:00.000Z",
          producerContext: {
            commands: null,
            kind: "ux-matrix",
            manifest: {
              href: "/api/evidence/artifact?artifactPath=manifest.json",
              path: "manifest.json",
              preview: null,
              runId: "run-1",
              runStatus: "pass",
            },
            matrix: {
              cells: [
                {
                  artifactKinds: ["screenshot"],
                  artifactPaths: ["screenshot.png"],
                  coverageIds: [],
                  runner: {
                    availability: "local",
                    command:
                      "node external/qa/ux-matrix-producer.mjs --artifact-base .artifacts/external-qa/ux-matrix",
                    lane: "web-ui-playwright",
                    workflow: "external/ci/ux-matrix.yml#matrix-local",
                  },
                  stage: "first-run",
                  status: "pass",
                  surface: "web-ui",
                  testId: "ux-matrix.web-ui.first-run",
                  title: "UX Matrix: web-ui / first-run",
                },
                {
                  artifactKinds: [],
                  artifactPaths: [],
                  coverageIds: [],
                  runner: {
                    availability: "local",
                    command:
                      "node external/qa/ux-matrix-producer.mjs --artifact-base .artifacts/external-qa/ux-matrix",
                    lane: "cli-status",
                    workflow: "external/ci/ux-matrix.yml#matrix-local",
                  },
                  stage: "first-run",
                  status: "proof-gap",
                  surface: "cli",
                  testId: null,
                  title: null,
                },
              ],
              counts: { pass: 1, "proof-gap": 1 },
              path: "matrix.json",
              stages: ["first-run"],
              surfaces: ["cli", "web-ui"],
            },
            preflight: { adbDevices: null, memory: null },
            releaseLedger: null,
            rootPath: ".artifacts/qa-e2e/suite/script/ux-matrix-producer/run-1",
            scorecard: null,
          },
          profile: null,
          schemaVersion: 2,
        },
        selectedEvidenceEntryId: "ux-matrix.web-ui.first-run",
      }),
    );

    expect(html).toContain('data-evidence-entry-id="ux-matrix.web-ui.first-run"');
    expect(html).toContain("evidence-matrix-cell-proof-gap");
    expect(html).toContain("not executed in this run");
    expect(html).not.toContain("Coverage:");
    expect(html).toContain("Runner: cli-status");
    expect(html).toContain("Open media artifact");
    expect(html).toContain("Open video artifact");
    expect(html).not.toContain('src="/api/evidence/artifact?artifactPath=recording.gif"');
    expect(html).not.toContain("<video controls");
    expect(html).not.toContain('data-evidence-entry-id="null"');
  });

  it("redacts secret-like capture payload fields in raw previews", () => {
    const payload =
      '{"message":"visible context","message":"duplicate context","completion_tokens":100,"cookies":["session=abc"],"apiToken":"secret-token","tokenValue":"token-value-secret","authTokens":["auth-token-secret"],"tokens":{"refresh":"refresh-token-secret"},"AWS_SECRET_ACCESS_KEY":"aws-secret","secretAccessKey":"access-secret","x-goog-api-key":"goog-secret","nested":{"password":"secret-password"}}';
    const html = renderQaLabUi(
      evidenceState({
        activeTab: "capture",
        captureDetailView: "payload",
        capturePayloadDetailLayout: "raw",
        captureEvents: [
          {
            contentType: "application/json",
            dataText: payload,
            direction: "outbound",
            flowId: "flow-1",
            host: "api.example.test",
            id: 1,
            kind: "request",
            method: "POST",
            path: "/v1/messages",
            payloadPreview: payload,
            protocol: "https",
            provider: "mock",
            ts: 1,
          },
        ],
        selectedCaptureEventKey: "1:flow-1:1:request",
      }),
    );

    expect(html).toContain("visible context");
    expect(html).toContain("duplicate context");
    expect(html).toContain("completion_tokens");
    expect(html).toContain("100");
    expect(html).toContain("apiToken");
    expect(html).toContain("nested");
    expect(html).toContain("[redacted]");
    expect(html).not.toContain("session=abc");
    expect(html).not.toContain("secret-token");
    expect(html).not.toContain("token-value-secret");
    expect(html).not.toContain("auth-token-secret");
    expect(html).not.toContain("refresh-token-secret");
    expect(html).not.toContain("aws-secret");
    expect(html).not.toContain("access-secret");
    expect(html).not.toContain("goog-secret");
    expect(html).not.toContain("secret-password");
  });

  it("redacts secret-like fields when captured JSON previews are truncated", () => {
    const payload =
      '{"apiToken":"secret-token","nested":{"password":"secret-password"},"message":"visible context"';
    for (const capturePayloadDetailLayout of ["raw", "formatted"] as const) {
      const html = renderQaLabUi(
        evidenceState({
          activeTab: "capture",
          captureDetailView: "payload",
          capturePayloadDetailLayout,
          captureEvents: [
            {
              contentType: "application/json",
              dataText: payload,
              direction: "outbound",
              flowId: "flow-1",
              host: "api.example.test",
              id: 1,
              kind: "request",
              method: "POST",
              path: "/v1/messages",
              payloadPreview: payload,
              protocol: "https",
              provider: "mock",
              ts: 1,
            },
          ],
          selectedCaptureEventKey: "1:flow-1:1:request",
        }),
      );

      expect(html).toContain("visible context");
      expect(html).toContain("[redacted]");
      expect(html).not.toContain("secret-token");
      expect(html).not.toContain("secret-password");
    }
  });

  it("redacts secret-like SSE data fields in formatted payloads", () => {
    const payload = 'event: message\ndata: {"apiToken":"secret-token","message":"visible"}';
    const html = renderQaLabUi(
      evidenceState({
        activeTab: "capture",
        captureDetailView: "payload",
        capturePayloadDetailLayout: "formatted",
        captureEvents: [
          {
            contentType: "text/event-stream",
            dataText: payload,
            direction: "inbound",
            flowId: "flow-1",
            host: "api.example.test",
            id: 1,
            kind: "response",
            path: "/v1/messages",
            payloadPreview: payload,
            protocol: "https",
            provider: "mock",
            ts: 1,
          },
        ],
        selectedCaptureEventKey: "1:flow-1:1:response",
      }),
    );

    expect(html).toContain("visible");
    expect(html).toContain("[redacted]");
    expect(html).not.toContain("secret-token");
  });

  it("redacts secret-like fields when capture cuts inside a JSON value", () => {
    const payload = '{"apiToken":"secret-token';
    const html = renderQaLabUi(
      evidenceState({
        activeTab: "capture",
        captureDetailView: "payload",
        capturePayloadDetailLayout: "raw",
        captureEvents: [
          {
            contentType: "application/json",
            dataText: payload,
            direction: "outbound",
            flowId: "flow-1",
            host: "api.example.test",
            id: 1,
            kind: "request",
            method: "POST",
            path: "/v1/messages",
            payloadPreview: payload,
            protocol: "https",
            provider: "mock",
            ts: 1,
          },
        ],
        selectedCaptureEventKey: "1:flow-1:1:request",
      }),
    );

    expect(html).toContain("[redacted]");
    expect(html).not.toContain("secret-token");
  });

  it.each([
    ["head", `${"a".repeat(279)}😀${"b".repeat(200)}`],
    ["tail", `${"a".repeat(350)}😀${"z".repeat(79)}`],
  ])("keeps the bounded capture %s free of lone surrogates", (_edge, payload) => {
    const html = renderQaLabUi(
      evidenceState({
        activeTab: "capture",
        captureDetailView: "payload",
        capturePayloadDetailLayout: "raw",
        captureEvents: [
          {
            contentType: "text/plain",
            dataText: payload,
            direction: "outbound",
            flowId: "flow-1",
            host: "api.example.test",
            id: 1,
            kind: "request",
            method: "POST",
            path: "/v1/messages",
            payloadPreview: payload,
            protocol: "https",
            provider: "mock",
            ts: 1,
          },
        ],
        selectedCaptureEventKey: "1:flow-1:1:request",
      }),
    );
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

    expect(html).not.toMatch(loneSurrogate);
  });
});
