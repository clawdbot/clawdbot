import { ZOOM_MEETING_SELECTORS } from "./zoom-meetings-selectors.js";
import { zoomMeetingStatusCallSource } from "./zoom-meetings-status-call-source.js";
import { zoomMeetingStatusPreludeSource } from "./zoom-meetings-status-prejoin-source.js";
import { normalizeZoomMeetingUrlForReuse } from "./zoom-meetings-urls.js";
const ZOOM_MEETING_TRANSCRIPT_MAX_LINES = 500;

function pageIdentityFunctionSource(): string {
  return `const meetingIdentity = (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      if (
        parsed.protocol !== "https:" ||
        !(host === "zoom.us" || host.endsWith(".zoom.us"))
      ) return undefined;
      const invitation = parsed.pathname.match(/^\\/j\\/(\\d{9,11})\\/?$/);
      const webClient = parsed.pathname.match(/^\\/wc\\/(\\d{9,11})\\/join\\/?$/);
      const meetingId = invitation?.[1] || webClient?.[1];
      return meetingId ? "zoom:" + meetingId : undefined;
    } catch {}
    return undefined;
  };`;
}

function zoomMeetingToggleStateFunctionSource(): string {
  return `(input) => {
    const pressed = String(input?.ariaPressed || "").toLowerCase();
    if (pressed === "true") return "on";
    if (pressed === "false") return "off";
    const checked = String(input?.ariaChecked ?? input?.checked ?? "").toLowerCase();
    if (checked === "true") return "on";
    if (checked === "false") return "off";
    const iconClass = String(input?.iconClass || "");
    if (input?.kind === "camera" && /videooff/i.test(iconClass)) return "off";
    if (input?.kind === "camera" && /videoon/i.test(iconClass)) return "on";
    const value = String(input?.label || "").toLowerCase().replace(/\\s+/g, " ").trim();
    if (!value) return undefined;
    if (input?.kind === "camera") {
      if (/\\bturn (?:your )?camera off\\b|\\bturn off (?:your )?camera\\b|\\bstop video\\b|\\bdisable (?:your )?(?:camera|video)\\b/.test(value)) return "on";
      if (/\\bturn (?:your )?camera on\\b|\\bturn on (?:your )?camera\\b|\\bstart video\\b|\\benable (?:your )?(?:camera|video)\\b/.test(value)) return "off";
      if (/\\b(?:camera|video) (?:is |currently )?(?:off|disabled)\\b/.test(value)) return "off";
      if (/\\b(?:camera|video) (?:is |currently )?(?:on|enabled)\\b/.test(value)) return "on";
      return undefined;
    }
    if (/^mute(?: mute)?$|\\bturn (?:your |my )?(?:microphone|mic) off\\b|\\bturn off (?:your |my )?(?:microphone|mic)\\b|\\bmute (?:your |my )?(?:microphone|mic)\\b|\\bdisable (?:your |my )?(?:microphone|mic)\\b/.test(value)) return "on";
    if (/^unmute(?: unmute)?$|\\bturn (?:your |my )?(?:microphone|mic) on\\b|\\bturn on (?:your |my )?(?:microphone|mic)\\b|\\bunmute (?:your |my )?(?:microphone|mic)\\b|\\benable (?:your |my )?(?:microphone|mic)\\b/.test(value)) return "off";
    if (/\\b(?:microphone|mic) (?:is |currently )?(?:off|muted|disabled)\\b/.test(value)) return "off";
    if (/\\b(?:microphone|mic) (?:is |currently )?(?:on|unmuted|enabled)\\b/.test(value)) return "on";
    return undefined;
  }`;
}

export function zoomMeetingStatusScript(params: {
  allowMicrophone: boolean;
  allowSessionAdoption: boolean;
  autoJoin: boolean;
  captureCaptions: boolean;
  guestName: string;
  meetingSessionId?: string;
  meetingUrl: string;
  readOnly?: boolean;
  waitForInCallMs: number;
}) {
  const selectors = JSON.stringify(ZOOM_MEETING_SELECTORS);
  const expectedIdentity = normalizeZoomMeetingUrlForReuse(params.meetingUrl);
  const toggleStateFunction = zoomMeetingToggleStateFunctionSource();
  return (
    zoomMeetingStatusPreludeSource({
      ...params,
      expectedIdentity,
      pageIdentitySource: pageIdentityFunctionSource(),
      selectors,
      toggleStateFunction,
    }) + zoomMeetingStatusCallSource()
  );
}

export function zoomMeetingTranscriptScript(
  meetingUrl: string,
  meetingSessionId: string,
  finalize: boolean,
) {
  const expectedIdentity = normalizeZoomMeetingUrlForReuse(meetingUrl);
  return `() => {
  ${pageIdentityFunctionSource()}
  const expectedIdentity = ${JSON.stringify(expectedIdentity)};
  const expectedSessionId = ${JSON.stringify(meetingSessionId)};
  const currentIdentity = meetingIdentity(location.href);
  const state = window.__openclawZoomMeeting;
  const activeCaptions = window.__openclawZoomCaptions;
  const archivedCaptions = window.__openclawZoomCaptionArchive?.[expectedSessionId];
  const captions = activeCaptions &&
      (!activeCaptions.sessionId || activeCaptions.sessionId === expectedSessionId)
    ? activeCaptions
    : archivedCaptions;
  // A same-session finalized buffer belongs to the departed call even if Zoom
  // immediately navigated this tab into another meeting before transcript pickup.
  const useFinalizedCaptions = Boolean(
    captions?.finalized === true &&
    captions?.identity === expectedIdentity &&
    (!captions?.sessionId || captions.sessionId === expectedSessionId)
  );
  const effectiveIdentity = useFinalizedCaptions
    ? captions.identity
    : currentIdentity || state?.identity || captions?.identity;
  if (!expectedIdentity || effectiveIdentity !== expectedIdentity) {
    return JSON.stringify({ urlMatched: false, droppedLines: 0, lines: [] });
  }
  if (!useFinalizedCaptions && state?.sessionId && state.sessionId !== expectedSessionId) {
    return JSON.stringify({ urlMatched: true, sessionMatched: false, droppedLines: 0, lines: [] });
  }
  if (captions?.sessionId && captions.sessionId !== expectedSessionId) {
    return JSON.stringify({ urlMatched: true, sessionMatched: false, droppedLines: 0, lines: [] });
  }
  if (${JSON.stringify(finalize)} && Array.isArray(captions?.visible) && captions.visible.length > 0) {
    if (captions.settleTimer !== undefined) clearTimeout(captions.settleTimer);
    captions.settleTimer = undefined;
    captions.lines = Array.isArray(captions.lines) ? captions.lines : [];
    captions.lines.push(...captions.visible.map((entry) => ({
      at: entry.at,
      speaker: entry.speaker,
      text: entry.text,
    })));
    captions.visible = [];
    const excess = captions.lines.length - ${ZOOM_MEETING_TRANSCRIPT_MAX_LINES};
    if (excess > 0) {
      captions.lines.splice(0, excess);
      captions.droppedLines = (captions.droppedLines || 0) + excess;
    }
  }
  if (${JSON.stringify(finalize)} && captions) {
    if (captions.settleTimer !== undefined) clearTimeout(captions.settleTimer);
    captions.settleTimer = undefined;
    captions.observer?.disconnect?.();
    captions.observer = undefined;
    captions.observerInstalled = false;
    captions.identity = expectedIdentity;
    captions.finalized = true;
    captions.finalizedAt = Date.now();
  }
  const allLines = [
    ...(Array.isArray(captions?.lines) ? captions.lines : []),
    ...(${JSON.stringify(finalize)} || !Array.isArray(captions?.visible) ? [] : captions.visible),
  ];
  const visibleOverflow = Math.max(0, allLines.length - ${ZOOM_MEETING_TRANSCRIPT_MAX_LINES});
  const lines = allLines.slice(-${ZOOM_MEETING_TRANSCRIPT_MAX_LINES});
  const result = {
    urlMatched: true,
    sessionMatched: true,
    epoch: typeof captions?.epoch === "string" ? captions.epoch : undefined,
    droppedLines: (Number.isFinite(captions?.droppedLines)
      ? Math.max(0, Math.trunc(captions.droppedLines))
      : 0) + visibleOverflow,
    lines: lines.map((line) => ({
      at: typeof line?.at === "string" ? line.at : undefined,
      speaker: typeof line?.speaker === "string" ? line.speaker : undefined,
      text: typeof line?.text === "string" ? line.text : "",
    })).filter((line) => line.text),
  };
  return JSON.stringify(result);
}`;
}

export function zoomMeetingLeaveScript(params: {
  leaveInitiated: boolean;
  meetingSessionId: string;
  meetingUrl: string;
}) {
  const selectors = JSON.stringify(ZOOM_MEETING_SELECTORS);
  const expectedIdentity = normalizeZoomMeetingUrlForReuse(params.meetingUrl);
  return `() => {
  ${pageIdentityFunctionSource()}
  const topDocument = globalThis.document;
  const document = topDocument.querySelector("#webclient")?.contentDocument || topDocument;
  const selectors = ${selectors};
  const expectedIdentity = ${JSON.stringify(expectedIdentity)};
  const expectedSessionId = ${JSON.stringify(params.meetingSessionId)};
  const leaveInitiated = ${JSON.stringify(params.leaveInitiated)};
  const currentIdentity = meetingIdentity(location.href);
  const state = window.__openclawZoomMeeting;
  const enforceSessionOwnership = Boolean(expectedSessionId);
  if (enforceSessionOwnership && state?.sessionId && state.sessionId !== expectedSessionId) {
    return JSON.stringify({ departed: false, sessionConflict: true, sessionMatched: false, urlMatched: true });
  }
  const sessionAdoptedFromUrl = Boolean(
    enforceSessionOwnership &&
    !state?.sessionId &&
    currentIdentity === expectedIdentity &&
    (!state?.identity || state.identity === expectedIdentity)
  );
  const sessionMatched = !enforceSessionOwnership ||
    state?.sessionId === expectedSessionId ||
    sessionAdoptedFromUrl;
  const retainedLeaveOwnership = Boolean(!sessionMatched && leaveInitiated);
  if (!sessionMatched && !retainedLeaveOwnership) {
    return JSON.stringify({ departed: false, sessionMatched: false, urlMatched: true });
  }
  const retireOwnedAudioBridges = () => {
    const entries = Array.isArray(window.__openclawZoomAudioOutputs)
      ? window.__openclawZoomAudioOutputs
      : [];
    const retained = [];
    const activeSessionId = expectedSessionId || state?.sessionId;
    for (const entry of entries) {
      const ownedByActiveSession = Boolean(
        !entry?.sessionId || (activeSessionId && entry.sessionId === activeSessionId)
      );
      if (!ownedByActiveSession) {
        retained.push(entry);
        continue;
      }
      const mediaSourceUrl = (element) => String(element?.currentSrc || element?.src || "");
      const sources = Array.isArray(entry?.sources)
        ? entry.sources
        : entry?.source
          ? [{ element: entry.source, muted: Boolean(entry.sourceMuted), stream: entry.stream, url: entry.sourceUrl }]
          : [];
      for (const source of sources) {
        const element = source?.element;
        const sourceMatches = source?.stream || element?.srcObject
          ? element?.srcObject === source?.stream
          : Boolean(source?.url && mediaSourceUrl(element) === source.url);
        const sourceIsEmpty = Boolean(element && !element.srcObject && !mediaSourceUrl(element));
        if (!element) continue;
        if (sourceIsEmpty) {
          element.muted = true;
          continue;
        }
        if (!sourceMatches) continue;
        const detachedLiveSource = Boolean(
          element.isConnected === false &&
          element.srcObject?.getAudioTracks?.().some((track) => track.readyState === "live")
        );
        if (detachedLiveSource) {
          element.muted = true;
          element.pause?.();
          element.srcObject = null;
        } else {
          element.muted = Boolean(source.muted);
        }
      }
      entry?.bridge?.pause?.();
      if (entry?.bridge) entry.bridge.srcObject = null;
      entry?.bridge?.remove?.();
    }
    if (retained.length > 0) window.__openclawZoomAudioOutputs = retained;
    else delete window.__openclawZoomAudioOutputs;
  };
  const first = (list) => {
    for (const selector of list) {
      const node = document.querySelector(selector);
      if (!node) continue;
      return node.matches?.("button") ? node : node.querySelector?.("button") || node.closest?.("button") || node;
    }
    return undefined;
  };
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const findTextButton = (pattern) => [...document.querySelectorAll("button")]
    .find((button) => !button.disabled && pattern.test(text(button)));
  const leave = first(selectors.leave);
  const confirmation = first(selectors.leaveConfirmation) ||
    findTextButton(/^leave meeting$/i);
  const postCall = !leave && (
    first(selectors.postCall) ||
    [...document.querySelectorAll(".zm-modal-body-title")]
      .find((node) => /meeting has been ended by host|you left the meeting|meeting has ended/i.test(text(node)))
  );
  const currentUrlMatches = Boolean(expectedIdentity && currentIdentity === expectedIdentity);
  let webClientHome = false;
  try {
    const currentUrl = new URL(location.href);
    webClientHome = !leave && currentUrl.hostname === "app.zoom.us" && /^\\/wc\\/?$/.test(currentUrl.pathname);
  } catch {}
  const preservedCallMatches = Boolean(
    expectedIdentity &&
    !currentIdentity &&
    state?.identity === expectedIdentity &&
    state?.inCallControl === leave &&
    state?.inCallUrl === location.href &&
    leave &&
    leave.isConnected !== false
  );
  const pendingLeaveMatches = Boolean(
    expectedIdentity &&
    state?.identity === expectedIdentity &&
    state?.leavePending === true &&
    state?.inCallUrl === location.href &&
    Date.now() - state?.leavePendingAt < 10_000
  );
  const rerenderPendingMatches = Boolean(
    expectedIdentity &&
    !currentIdentity &&
    state?.identity === expectedIdentity &&
    state?.inCallControl?.isConnected === false &&
    state?.inCallUrl === location.href &&
    Date.now() - state?.verifiedAt < 5_000 &&
    !leave
  );
  const meetingIdentityMatches = Boolean(
    currentUrlMatches || preservedCallMatches || pendingLeaveMatches || rerenderPendingMatches
  );
  // Zoom can replace the document between our Leave click and its post-call marker.
  // Retain request ownership only while no identity or live-call control contradicts it.
  const initiatedLeaveTransitionMatches = Boolean(
    leaveInitiated &&
    !currentIdentity &&
    !leave &&
    (!state?.identity || state.identity === expectedIdentity)
  );
  if ((postCall || webClientHome) && (meetingIdentityMatches || initiatedLeaveTransitionMatches)) {
    retireOwnedAudioBridges();
    if (sessionMatched) delete window.__openclawZoomMeeting;
    return JSON.stringify({ departed: true, sessionMatched: true, urlMatched: true });
  }
  if (!meetingIdentityMatches && !initiatedLeaveTransitionMatches) {
    return JSON.stringify({ departed: false, urlMatched: false });
  }
  if (!sessionMatched) {
    return JSON.stringify({ departed: false, urlMatched: true });
  }
  if (confirmation) {
    confirmation.click();
    return JSON.stringify({ departed: false, leaveAction: "confirm", urlMatched: true });
  }
  if (leave) {
    window.__openclawZoomMeeting = {
      ...state,
      identity: expectedIdentity,
      sessionId: expectedSessionId || state?.sessionId,
      inCallControl: leave,
      inCallUrl: location.href,
      leavePending: true,
      leavePendingAt: Date.now(),
    };
    leave.click();
    return JSON.stringify({ departed: false, leaveAction: "leave", urlMatched: true });
  }
  return JSON.stringify({ departed: false, urlMatched: true });
}`;
}
