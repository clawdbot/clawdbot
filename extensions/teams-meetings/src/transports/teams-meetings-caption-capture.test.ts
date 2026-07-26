import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  teamsMeetingStatusScript,
  teamsMeetingTranscriptScript,
} from "./teams-meetings-page-scripts.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./teams-meetings-platform-adapter.js";
import {
  URL,
  CONSUMER_URL,
  MEETING_STATE_KEY,
  control,
  captionRow,
  runStatusScript,
} from "./teams-meetings-platform-adapter.test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Microsoft Teams meeting captions and permissions", () => {
  it("builds the guest join script from centralized stable selectors and text fallbacks", () => {
    const script = teamsMeetingStatusScript({
      allowMicrophone: true,
      allowSessionAdoption: true,
      autoJoin: true,
      captureCaptions: true,
      guestName: "OpenClaw Guest",
      meetingSessionId: "session-1",
      meetingUrl: URL,
      waitForInCallMs: 60_000,
    });
    expect(script).toContain('data-tid=\\"prejoin-display-name-input\\"');
    expect(script).toContain('data-tid=\\"call-hangup\\"');
    expect(script).toContain("continue on this browser");
    expect(script).toContain("someone will let you in shortly");
    expect(script).toContain("setSinkId");
    expect(script).toContain("BlackHole");
  });

  it("enables live captions and captures the validated Teams caption row DOM", async () => {
    const leave = control({ label: "Leave" });
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Copper lantern validates Teams captions seven.")],
      captureCaptions: true,
      leave,
    });

    expect(result).toMatchObject({
      captioning: true,
      captionsEnabledAttempted: true,
      inCall: true,
      lastCaptionSpeaker: "OpenClaw QA",
      lastCaptionText: "Copper lantern validates Teams captions seven.",
      transcriptLines: 1,
    });
    const readTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "session-1", false)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        document: {},
        location: new globalThis.URL(URL),
        window,
      },
    ) as () => string;
    expect(JSON.parse(readTranscript())).toMatchObject({
      droppedLines: 0,
      epoch: "teams-caption-epoch",
      lines: [
        {
          speaker: "OpenClaw QA",
          text: "Copper lantern validates Teams captions seven.",
        },
      ],
      sessionMatched: true,
      urlMatched: true,
    });
    expect(window["__openclawTeamsCaptions"]).toMatchObject({
      identity: "teams-work:19:meeting_test@thread.v2",
    });
  });

  it("retries an unverified live-caption activation", async () => {
    const first = await runStatusScript({
      allowMicrophone: false,
      captionClickIgnored: true,
      captionsInitiallyOn: false,
      captionRows: [captionRow("OpenClaw QA", "Retry captions")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    expect(first.captionButton.clicks).toBe(1);
    expect(first.result).toMatchObject({
      captioning: false,
      captionsEnabledAttempted: false,
    });

    const second = await runStatusScript({
      allowMicrophone: false,
      captionsInitiallyOn: false,
      captionRows: [captionRow("OpenClaw QA", "Retry captions")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.captionButton.clicks).toBe(1);
    expect(second.result).toMatchObject({
      captioning: true,
      captionsEnabledAttempted: true,
    });
  });

  it("preserves valid one-character caption lines", async () => {
    const { result } = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "I")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });

    expect(result).toMatchObject({
      lastCaptionText: "I",
      recentTranscript: [{ speaker: "OpenClaw QA", text: "I" }],
      transcriptLines: 1,
    });
  });

  it("bounds visible and committed caption rows together", async () => {
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      captionRows: Array.from({ length: 505 }, (_, index) =>
        captionRow("OpenClaw QA", `Bounded caption ${index}`),
      ),
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const state = window["__openclawTeamsCaptions"] as {
      droppedLines: number;
      lines: unknown[];
      visible: unknown[];
    };

    expect(state.lines).toHaveLength(0);
    expect(state.visible).toHaveLength(505);
    expect(state.droppedLines).toBe(0);
    expect(result.transcriptLines).toBe(505);
    const readTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "session-1", false)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        document: {},
        location: new globalThis.URL(URL),
        window,
      },
    ) as () => string;
    const transcript = JSON.parse(readTranscript()) as { droppedLines: number; lines: unknown[] };
    expect(transcript.lines).toHaveLength(500);
    expect(transcript.droppedLines).toBe(5);
  });

  it("keeps repeated utterances from distinct caption rows", async () => {
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Yes")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Yes")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });

    expect(second.result.transcriptLines).toBe(2);
  });

  it("keeps the latest caption when Teams shortens a provisional row", async () => {
    vi.useFakeTimers();
    const row = captionRow("OpenClaw QA", "We should leave today");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionsInitiallyOn: true,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const caption = row.querySelector('[data-tid="closed-caption-text"]');
    if (!caption) {
      throw new Error("expected caption text control");
    }
    caption.textContent = "We should leave";
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });

    expect(second.result.lastCaptionText).toBe("We should leave");
    expect(second.result.recentTranscript).toMatchObject([
      { speaker: "OpenClaw QA", text: "We should leave" },
    ]);
  });

  it("keeps a mid-sentence caption correction in the same row lifecycle", async () => {
    const row = captionRow("OpenClaw QA", "I like cats");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const caption = row.querySelector('[data-tid="closed-caption-text"]');
    if (!caption) {
      throw new Error("expected caption text control");
    }
    caption.textContent = "I liked cats";
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });

    expect(second.result.transcriptLines).toBe(1);
    expect(second.result.lastCaptionText).toBe("I liked cats");
  });

  it("keeps one utterance when Teams replaces a logically identical caption row", async () => {
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Logical row", "8")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Logical row replacement", "8")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });

    expect(second.result.transcriptLines).toBe(1);
    expect(second.result.lastCaptionText).toBe("Logical row replacement");
  });

  it("updates a settled logical row in place when Teams corrects it late", async () => {
    vi.useFakeTimers();
    const first = await runStatusScript({
      allowMicrophone: false,
      captionsInitiallyOn: true,
      captionRows: [captionRow("OpenClaw QA", "Late logical", "9")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Late logical correction", "9")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });

    expect(second.result.transcriptLines).toBe(1);
    expect(second.result.recentTranscript).toMatchObject([{ text: "Late logical correction" }]);
  });

  it("deduplicates a settled logical row after temporary DOM removal", async () => {
    vi.useFakeTimers();
    const first = await runStatusScript({
      allowMicrophone: false,
      captionsInitiallyOn: true,
      captionRows: [captionRow("OpenClaw QA", "Virtual row return", "13")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const missing = await runStatusScript({
      allowMicrophone: false,
      captionRows: [],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });
    const returned = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Virtual row return", "13")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: missing.window["__openclawTeamsCaptions"],
    });

    expect(returned.result.transcriptLines).toBe(1);
    expect(returned.result.recentTranscript).toMatchObject([{ text: "Virtual row return" }]);
  });

  it("commits an utterance when Teams recycles the same virtual-list row", async () => {
    vi.useFakeTimers();
    const row = captionRow("OpenClaw QA", "First recycled-row utterance");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionsInitiallyOn: true,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const disappeared = await runStatusScript({
      allowMicrophone: false,
      captionRows: [],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const caption = row.querySelector('[data-tid="closed-caption-text"]');
    if (!caption) {
      throw new Error("expected caption text control");
    }
    caption.textContent = "Completely different second utterance";
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: disappeared.window["__openclawTeamsCaptions"],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });

    expect(second.result.transcriptLines).toBe(2);
    expect(second.result.recentTranscript).toMatchObject([
      { text: "First recycled-row utterance" },
      { text: "Completely different second utterance" },
    ]);
  });

  it("commits a removed row before Teams rapidly reuses its DOM node", async () => {
    const row = captionRow("OpenClaw QA", "Rapid first utterance");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const caption = row.querySelector('[data-tid="closed-caption-text"]');
    if (!caption) {
      throw new Error("expected caption text control");
    }
    caption.textContent = "Rapid second utterance";
    first.triggerCaptionMutation(undefined, row);
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });

    expect(second.result.transcriptLines).toBe(2);
    expect(second.result.recentTranscript).toMatchObject([
      { text: "Rapid first utterance" },
      { text: "Rapid second utterance" },
    ]);
  });

  it("does not merge recycled rows that only share a text prefix", async () => {
    vi.useFakeTimers();
    const row = captionRow("OpenClaw QA", "Thank you");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionsInitiallyOn: true,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const disappeared = await runStatusScript({
      allowMicrophone: false,
      captionRows: [],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const caption = row.querySelector('[data-tid="closed-caption-text"]');
    if (!caption) {
      throw new Error("expected caption text control");
    }
    caption.textContent = "Thank you everyone";
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: disappeared.window["__openclawTeamsCaptions"],
    });

    expect(second.result.recentTranscript).toMatchObject([
      { text: "Thank you" },
      { text: "Thank you everyone" },
    ]);
  });

  it("retains settled markers for older rows while newer captions settle", async () => {
    vi.useFakeTimers();
    const firstRow = captionRow("OpenClaw QA", "First settled row", "11");
    const secondRow = captionRow("OpenClaw QA", "Second settled row", "12");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionsInitiallyOn: true,
      captionRows: [firstRow],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [firstRow, secondRow],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const third = await runStatusScript({
      allowMicrophone: false,
      captionRows: [firstRow, secondRow],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: second.window["__openclawTeamsCaptions"],
    });

    expect(third.result.transcriptLines).toBe(2);
    expect(third.result.recentTranscript).toMatchObject([
      { text: "First settled row" },
      { text: "Second settled row" },
    ]);
  });

  it("updates a caption when its speaker label arrives late", async () => {
    const row = captionRow("", "Late attribution");
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const author = row.querySelector('[data-tid="author"]');
    if (!author) {
      throw new Error("expected caption author control");
    }
    author.textContent = "OpenClaw QA";
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [row],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });

    expect(second.result.transcriptLines).toBe(1);
    expect(second.result.recentTranscript).toMatchObject([
      { speaker: "OpenClaw QA", text: "Late attribution" },
    ]);
  });

  it("updates a corrected speaker on the same logical row before settlement", async () => {
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw Q", "Stable speaker correction", "10")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    const second = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Stable speaker correction", "10")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: first.window["__openclawTeamsCaptions"],
    });

    expect(second.result.transcriptLines).toBe(1);
    expect(second.result.recentTranscript).toMatchObject([
      { speaker: "OpenClaw QA", text: "Stable speaker correction" },
    ]);
  });

  it("disconnects stale caption capture outside transcribe mode", async () => {
    let disconnects = 0;
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: false,
      leave: control({ label: "Leave" }),
      priorCaptions: {
        observer: { disconnect: () => (disconnects += 1) },
        observerInstalled: true,
      },
    });

    expect(disconnects).toBe(1);
    expect(window).not.toHaveProperty("__openclawTeamsCaptions");
  });

  it("does not clear captions owned by another tab or meeting session", async () => {
    let disconnects = 0;
    const active = {
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "another-session",
    };
    const wrongTab = await runStatusScript({
      allowMicrophone: false,
      allowSessionAdoption: false,
      captureCaptions: false,
      currentUrl: "https://teams.live.com/v2/",
      leave: control({ label: "Leave" }),
      priorCaptions: active,
    });
    const wrongSession = await runStatusScript({
      allowMicrophone: false,
      allowSessionAdoption: false,
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: active,
    });

    expect(disconnects).toBe(0);
    expect(wrongTab.window["__openclawTeamsCaptions"]).toBe(active);
    expect(wrongSession.window["__openclawTeamsCaptions"]).toBe(active);
  });

  it("finalizes requested-session capture after a confirmed SPA meeting transition", async () => {
    let disconnects = 0;
    const captions = {
      droppedLines: 0,
      lines: [],
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "session-1",
      visible: [{ text: "Last caption before navigation" }],
    };
    const { window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: CONSUMER_URL,
      priorCaptions: captions,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
      readOnly: true,
    });

    expect(disconnects).toBe(1);
    expect(captions).toMatchObject({
      finalized: true,
      lines: [{ text: "Last caption before navigation" }],
    });
    expect(window[MEETING_STATE_KEY]).toBeUndefined();
  });

  it("finalizes same-session captions when meeting identity is lost", async () => {
    let disconnects = 0;
    const currentUrl = "https://teams.live.com/v2/";
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: true,
      currentUrl,
      leave: control({ label: "Leave" }),
      priorCaptions: {
        droppedLines: 0,
        epoch: "caption-epoch",
        lines: [],
        observer: { disconnect: () => (disconnects += 1) },
        observerInstalled: true,
        sessionId: "session-1",
        visible: [
          {
            at: "2026-07-17T12:00:00.000Z",
            speaker: "OpenClaw QA",
            text: "Preserve call-end captions",
          },
        ],
      },
    });
    const captions = window["__openclawTeamsCaptions"] as Record<string, unknown>;
    const readTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "session-1", true)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        document: {},
        location: new globalThis.URL(currentUrl),
        window,
      },
    ) as () => string;
    const transcript = JSON.parse(readTranscript()) as { lines: Array<{ text: string }> };

    expect(disconnects).toBe(1);
    expect(captions.finalized).toBe(true);
    expect(transcript.lines).toMatchObject([{ text: "Preserve call-end captions" }]);
    expect(JSON.parse(readTranscript())).toMatchObject({
      lines: [{ text: "Preserve call-end captions" }],
    });
    expect(window["__openclawTeamsCaptions"]).toBe(captions);
  });

  it("finalizes caption capture before an SPA navigation can mix meetings", async () => {
    const params = {
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Meeting A caption")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    };
    const page = await runStatusScript(params);

    params.captionRows = [captionRow("OpenClaw QA", "Meeting B caption")];
    page.triggerCaptionMutation(CONSUMER_URL);

    const captions = page.window["__openclawTeamsCaptions"] as {
      finalized?: boolean;
      lines?: Array<{ text: string }>;
      visible?: Array<{ text: string }>;
    };
    expect(page.captionObserverDisconnects()).toBe(1);
    expect(captions.finalized).toBe(true);
    expect([...(captions.lines ?? []), ...(captions.visible ?? [])]).toMatchObject([
      { text: "Meeting A caption" },
    ]);
  });

  it("returns finalized captions after the tab navigates into another meeting", () => {
    const window = {
      __openclawTeamsCaptions: {
        droppedLines: 0,
        finalized: true,
        identity: "teams-work:19:meeting_test@thread.v2",
        lines: [{ text: "Finalized before navigation" }],
        sessionId: "session-1",
        visible: [],
      },
      __openclawTeamsMeeting: {
        identity: "teams-consumer:9326458712345:abc",
        sessionId: "session-2",
      },
    };
    const readTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "session-1", true)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        location: new globalThis.URL(CONSUMER_URL),
        window,
      },
    ) as () => string;

    expect(JSON.parse(readTranscript())).toMatchObject({
      urlMatched: true,
      sessionMatched: true,
      lines: [{ text: "Finalized before navigation" }],
    });
    expect(JSON.parse(readTranscript())).toMatchObject({
      lines: [{ text: "Finalized before navigation" }],
    });
    expect(window["__openclawTeamsCaptions"]).toBeDefined();
  });

  it("preserves same-session captions during the in-call rerender window", async () => {
    let disconnects = 0;
    const staleControl = control({ label: "Leave" });
    staleControl.isConnected = false;
    const active = {
      droppedLines: 0,
      enabledAttempted: true,
      lines: [],
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "session-1",
      visible: [],
    };
    const currentUrl = "https://teams.live.com/v2/";
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: true,
      currentUrl,
      priorCaptions: active,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: staleControl,
        inCallUrl: currentUrl,
        sessionId: "session-1",
        verifiedAt: Date.now(),
      },
    });

    expect(disconnects).toBe(0);
    expect(window["__openclawTeamsCaptions"]).toBe(active);
  });

  it("keeps the live caption observer during a bounded in-call control rerender", async () => {
    const leave = control({ label: "Leave" });
    const currentUrl = "https://teams.live.com/v2/";
    const page = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Caption before control rerender")],
      captureCaptions: true,
      currentUrl,
      leave,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: leave,
        inCallUrl: currentUrl,
        sessionId: "session-1",
        verifiedAt: Date.now(),
      },
    });

    leave.isConnected = false;
    page.triggerCaptionMutation();

    expect(page.captionObserverDisconnects()).toBe(0);
    expect(page.window["__openclawTeamsCaptions"]).not.toMatchObject({ finalized: true });
  });

  it("replaces finalized captions for a new verified session", async () => {
    const old = {
      droppedLines: 0,
      epoch: "old-epoch",
      finalized: true,
      lines: [{ text: "Old session" }],
      observerInstalled: false,
      sessionId: "old-session",
      visible: [],
    };
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "New session")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: old,
    });
    const current = window["__openclawTeamsCaptions"] as Record<string, unknown>;

    expect(current).not.toBe(old);
    expect(current.sessionId).toBe("session-1");
    expect(current.epoch).toBe("teams-caption-epoch");
  });

  it("atomically refuses to replace a newer live owner during recovery", async () => {
    let disconnects = 0;
    const leave = control({ label: "Leave" });
    const priorMeeting = {
      identity: "teams-work:19:meeting_test@thread.v2",
      inCallControl: leave,
      inCallUrl: URL,
      sessionId: "newer-session",
      verifiedAt: Date.now(),
    };
    const priorCaptions = {
      droppedLines: 0,
      lines: [{ text: "Newer live caption" }],
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "newer-session",
      visible: [],
    };

    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      allowSessionAdoption: false,
      captureCaptions: true,
      leave,
      priorCaptions,
      priorMeeting,
    });

    expect(result).toMatchObject({
      manualActionReason: "teams-session-conflict",
      manualActionRequired: true,
    });
    expect(window[MEETING_STATE_KEY]).toBe(priorMeeting);
    expect(window["__openclawTeamsCaptions"]).toBe(priorCaptions);
    expect(disconnects).toBe(0);
  });

  it("treats a missing recovery session ID as foreign to committed page state", async () => {
    let disconnects = 0;
    const leave = control({ label: "Leave" });
    const priorMeeting = {
      identity: "teams-work:19:meeting_test@thread.v2",
      inCallControl: leave,
      inCallUrl: URL,
      sessionId: "active-session",
      verifiedAt: Date.now(),
    };
    const priorCaptions = {
      droppedLines: 0,
      lines: [{ text: "Active session caption" }],
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "active-session",
      visible: [],
    };

    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      allowSessionAdoption: false,
      captureCaptions: true,
      leave,
      meetingSessionId: "",
      priorCaptions,
      priorMeeting,
    });

    expect(result).toMatchObject({
      manualActionReason: "teams-session-conflict",
      manualActionRequired: true,
    });
    expect(window[MEETING_STATE_KEY]).toBe(priorMeeting);
    expect(window["__openclawTeamsCaptions"]).toBe(priorCaptions);
    expect(disconnects).toBe(0);
  });

  it("repairs a stale caption owner for the committed meeting session", async () => {
    let disconnects = 0;
    const staleCaptions = {
      droppedLines: 0,
      lines: [{ text: "Stale caption owner" }],
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "stale-session",
      visible: [],
    };
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      allowSessionAdoption: false,
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: staleCaptions,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
    });

    expect(result.manualActionRequired).toBe(false);
    expect(disconnects).toBe(1);
    expect(staleCaptions).toMatchObject({ finalized: true });
    expect(window["__openclawTeamsCaptions"]).toMatchObject({ sessionId: "session-1" });
  });

  it("disconnects caption capture when finalizing a transcript", async () => {
    const first = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Final caption")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
    });
    let disconnects = 0;
    const captions = first.window["__openclawTeamsCaptions"] as Record<string, unknown>;
    captions.observer = { disconnect: () => (disconnects += 1) };
    captions.observerInstalled = true;
    const finalize = runInNewContext(`(${teamsMeetingTranscriptScript(URL, "session-1", true)})`, {
      URL: globalThis.URL,
      clearTimeout,
      document: {},
      location: new globalThis.URL(URL),
      window: first.window,
    }) as () => string;
    finalize();

    expect(disconnects).toBe(1);
    expect(captions.observerInstalled).toBe(false);
    expect(captions.identity).toBe("teams-work:19:meeting_test@thread.v2");
    expect(typeof captions.finalizedAt).toBe("number");

    const refreshed = await runStatusScript({
      allowMicrophone: false,
      captionRows: [captionRow("OpenClaw QA", "Late caption")],
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: captions,
    });
    expect(refreshed.window["__openclawTeamsCaptions"]).toBe(captions);
    expect(captions.observerInstalled).toBe(false);
    expect(captions.lines).toMatchObject([{ text: "Final caption" }]);
  });

  it("enables caption capture for durable notes in every mode and parses snapshots", () => {
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("agent")).toBe(true);
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("bidi")).toBe(true);
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("transcribe")).toBe(true);
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.parseTranscript({
        result: JSON.stringify({
          droppedLines: 2,
          epoch: "caption-epoch",
          urlMatched: true,
          sessionMatched: true,
          lines: [
            {
              at: "2026-07-17T12:00:00.000Z",
              speaker: "OpenClaw QA",
              text: "Copper lantern validates Teams captions seven.",
            },
          ],
        }),
      }),
    ).toEqual({
      droppedLines: 2,
      epoch: "caption-epoch",
      lines: [
        {
          at: "2026-07-17T12:00:00.000Z",
          speaker: "OpenClaw QA",
          text: "Copper lantern validates Teams captions seven.",
        },
      ],
      urlMatched: true,
      sessionMatched: true,
    });
  });

  it("grants media permissions only to the exact Teams meeting origin", () => {
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: true,
        meetingUrl: URL,
      }),
    ).toEqual({
      origin: "https://teams.microsoft.com",
      permissions: ["audioCapture"],
      optionalPermissions: ["speakerSelection"],
    });
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: true,
        meetingUrl: "https://teams.live.com/meet/123?p=abc",
      }),
    ).toMatchObject({ origin: "https://teams.live.com" });
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: true,
        meetingUrl: "https://evil.example/meet/123",
      }),
    ).toBeUndefined();
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: true,
        meetingUrl: "https://teams.microsoft.com:8443/l/meetup-join/test",
      }),
    ).toBeUndefined();
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: true,
        meetingUrl: "https://teams.live.com:444/meet/123",
      }),
    ).toBeUndefined();
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissionNotes({ allowMicrophone: true }),
    ).toContain("Granted Teams microphone permission through browser control.");
  });

  it("parses leave steps and malformed status", () => {
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.parseLeaveResult({
        result: JSON.stringify({
          departed: false,
          leaveAction: "confirm",
          sessionMatched: true,
          urlMatched: true,
        }),
      }),
    ).toEqual({
      departed: false,
      leaveAction: "confirm",
      sessionMatched: true,
      urlMatched: true,
    });
    expect(() =>
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.parseStatus({ result: "not-json" }),
    ).toThrow("Microsoft Teams browser status JSON is malformed.");
  });
});
