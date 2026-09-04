type MeetingPageScriptGlobals = {
  audioOutputs: string;
  captionArchive: string;
  captions: string;
  meeting: string;
};

function pageGlobalSource(name: string): string {
  if (!/^[$A-Z_a-z][$\w]*$/u.test(name)) {
    throw new Error(`Invalid meeting page global: ${name}`);
  }
  return `window.${name}`;
}

export function createMeetingTranscriptSource(params: {
  expectedIdentity?: string;
  finalize: boolean;
  globals: Pick<MeetingPageScriptGlobals, "captionArchive" | "captions" | "meeting">;
  meetingSessionId: string;
  pageIdentitySource: string;
  platformDisplayName: string;
  transcriptMaxLines?: number;
}): string {
  const transcriptMaxLines = params.transcriptMaxLines ?? 500;
  const meetingGlobal = pageGlobalSource(params.globals.meeting);
  const captionsGlobal = pageGlobalSource(params.globals.captions);
  const captionArchiveGlobal = pageGlobalSource(params.globals.captionArchive);
  return `() => {
  ${params.pageIdentitySource}
  const expectedIdentity = ${JSON.stringify(params.expectedIdentity)};
  const expectedSessionId = ${JSON.stringify(params.meetingSessionId)};
  const currentIdentity = meetingIdentity(location.href);
  const state = ${meetingGlobal};
  const activeCaptions = ${captionsGlobal};
  const archivedCaptions = ${captionArchiveGlobal}?.[expectedSessionId];
  const captions = activeCaptions &&
      (!activeCaptions.sessionId || activeCaptions.sessionId === expectedSessionId)
    ? activeCaptions
    : archivedCaptions;
  // A same-session finalized buffer belongs to the departed call even if ${params.platformDisplayName}
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
  if (${JSON.stringify(params.finalize)} && Array.isArray(captions?.visible) && captions.visible.length > 0) {
    if (captions.settleTimer !== undefined) clearTimeout(captions.settleTimer);
    captions.settleTimer = undefined;
    captions.lines = Array.isArray(captions.lines) ? captions.lines : [];
    captions.lines.push(...captions.visible.map((entry) => ({
      at: entry.at,
      speaker: entry.speaker,
      text: entry.text,
    })));
    captions.visible = [];
    const excess = captions.lines.length - ${transcriptMaxLines};
    if (excess > 0) {
      captions.lines.splice(0, excess);
      captions.droppedLines = (captions.droppedLines || 0) + excess;
    }
  }
  if (${JSON.stringify(params.finalize)} && captions) {
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
    ...(${JSON.stringify(params.finalize)} || !Array.isArray(captions?.visible) ? [] : captions.visible),
  ];
  const visibleOverflow = Math.max(0, allLines.length - ${transcriptMaxLines});
  const lines = allLines.slice(-${transcriptMaxLines});
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

function createMeetingOwnedAudioLeaveSource(params: { audioOutputsGlobal: string }): string {
  const audioOutputsGlobal = pageGlobalSource(params.audioOutputsGlobal);
  return `const retireOwnedAudioBridges = () => {
    const entries = Array.isArray(${audioOutputsGlobal})
      ? ${audioOutputsGlobal}
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
    if (retained.length > 0) ${audioOutputsGlobal} = retained;
    else delete ${audioOutputsGlobal};
  };`;
}

export function createMeetingLeaveSource(params: {
  controlSource: string;
  departedMarkerSource: string;
  documentSetupSource?: string;
  expectedIdentity?: string;
  leaveInitiated: boolean;
  meetingSessionId: string;
  meetingStateSource?: string;
  pageIdentitySource: string;
  platform: {
    displayName: string;
    globals: Pick<MeetingPageScriptGlobals, "audioOutputs" | "meeting">;
  };
  selectors: string;
  sessionMatchSource: string;
}): string {
  const documentSetupSource = params.documentSetupSource ? `${params.documentSetupSource}\n  ` : "";
  const meetingStateSource = params.meetingStateSource
    ? `      ${params.meetingStateSource}\n`
    : "";
  const meetingGlobal = pageGlobalSource(params.platform.globals.meeting);
  return `() => {
  ${params.pageIdentitySource}
  ${documentSetupSource}const selectors = ${params.selectors};
  const expectedIdentity = ${JSON.stringify(params.expectedIdentity)};
  const expectedSessionId = ${JSON.stringify(params.meetingSessionId)};
  const leaveInitiated = ${JSON.stringify(params.leaveInitiated)};
  const currentIdentity = meetingIdentity(location.href);
  const state = ${meetingGlobal};
  const enforceSessionOwnership = Boolean(expectedSessionId);
  if (enforceSessionOwnership && state?.sessionId && state.sessionId !== expectedSessionId) {
    return JSON.stringify({ departed: false, sessionConflict: true, sessionMatched: false, urlMatched: true });
  }
  ${params.sessionMatchSource}
  const retainedLeaveOwnership = Boolean(!sessionMatched && leaveInitiated);
  if (!sessionMatched && !retainedLeaveOwnership) {
    return JSON.stringify({ departed: false, sessionMatched: false, urlMatched: true });
  }
  ${createMeetingOwnedAudioLeaveSource({
    audioOutputsGlobal: params.platform.globals.audioOutputs,
  })}
  ${params.controlSource}
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
  // ${params.platform.displayName} can replace the document between our Leave click and its post-call marker.
  // Retain request ownership only while no identity or live-call control contradicts it.
  const initiatedLeaveTransitionMatches = Boolean(
    leaveInitiated &&
    !currentIdentity &&
    !leave &&
    (!state?.identity || state.identity === expectedIdentity)
  );
  if (${params.departedMarkerSource} && (meetingIdentityMatches || initiatedLeaveTransitionMatches)) {
    retireOwnedAudioBridges();
    if (sessionMatched) delete ${meetingGlobal};
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
    ${meetingGlobal} = {
      ...state,
      identity: expectedIdentity,
${meetingStateSource}      inCallControl: leave,
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
