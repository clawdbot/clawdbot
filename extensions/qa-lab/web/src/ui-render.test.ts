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
    scenarioRun: null,
    selectedCaptureEventKey: null,
    selectedCaptureSessionIds: [],
    selectedConversationId: null,
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
              coverage: [{ id: "ui.control", role: "primary" }],
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
                  coverageIds: ["ui.control"],
                  runner: {
                    availability: "local",
                    command: "pnpm openclaw qa suite --scenario ux-matrix-evidence-dashboard",
                    lane: "web-ui-playwright",
                    workflow: ".github/workflows/ux-matrix-qa.yml#ux-matrix-local",
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
                  coverageIds: ["cli.entrypoint"],
                  runner: {
                    availability: "local",
                    command: "pnpm openclaw qa suite --scenario ux-matrix-evidence-dashboard",
                    lane: "cli-status",
                    workflow: ".github/workflows/ux-matrix-qa.yml#ux-matrix-local",
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
            rootPath: ".artifacts/qa-e2e/suite/script/ux-matrix-evidence-dashboard/run-1",
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
    expect(html).toContain("Coverage: cli.entrypoint");
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
