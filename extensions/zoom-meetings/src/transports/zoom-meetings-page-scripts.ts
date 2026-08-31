import {
  createMeetingLeaveSource,
  createMeetingTranscriptSource,
} from "openclaw/plugin-sdk/meeting-page-script-runtime";
import { ZOOM_MEETING_SELECTORS } from "./zoom-meetings-selectors.js";
import { zoomMeetingStatusCallSource } from "./zoom-meetings-status-call-source.js";
import { zoomMeetingStatusPreludeSource } from "./zoom-meetings-status-prejoin-source.js";
import { normalizeZoomMeetingUrlForReuse } from "./zoom-meetings-urls.js";

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
  return createMeetingTranscriptSource({
    expectedIdentity,
    finalize,
    globals: {
      captionArchive: "__openclawZoomCaptionArchive",
      captions: "__openclawZoomCaptions",
      meeting: "__openclawZoomMeeting",
    },
    meetingSessionId,
    pageIdentitySource: pageIdentityFunctionSource(),
    platformDisplayName: "Zoom",
  });
}

export function zoomMeetingLeaveScript(params: {
  leaveInitiated: boolean;
  meetingSessionId: string;
  meetingUrl: string;
}) {
  const selectors = JSON.stringify(ZOOM_MEETING_SELECTORS);
  const expectedIdentity = normalizeZoomMeetingUrlForReuse(params.meetingUrl);
  return createMeetingLeaveSource({
    controlSource: `const first = (list) => {
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
  } catch {}`,
    departedMarkerSource: "(postCall || webClientHome)",
    documentSetupSource: `const topDocument = globalThis.document;
  const document = topDocument.querySelector("#webclient")?.contentDocument || topDocument;`,
    expectedIdentity,
    leaveInitiated: params.leaveInitiated,
    meetingSessionId: params.meetingSessionId,
    meetingStateSource: "sessionId: expectedSessionId || state?.sessionId,",
    pageIdentitySource: pageIdentityFunctionSource(),
    platform: {
      displayName: "Zoom",
      globals: {
        audioOutputs: "__openclawZoomAudioOutputs",
        meeting: "__openclawZoomMeeting",
      },
    },
    selectors,
    sessionMatchSource: `const sessionAdoptedFromUrl = Boolean(
    enforceSessionOwnership &&
    !state?.sessionId &&
    currentIdentity === expectedIdentity &&
    (!state?.identity || state.identity === expectedIdentity)
  );
  const sessionMatched = !enforceSessionOwnership ||
    state?.sessionId === expectedSessionId ||
    sessionAdoptedFromUrl;`,
  });
}
