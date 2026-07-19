type TeamsMeetingStatusPreludeParams = {
  allowMicrophone: boolean;
  allowSessionAdoption: boolean;
  autoJoin: boolean;
  captureCaptions: boolean;
  expectedIdentity?: string;
  guestName: string;
  meetingSessionId?: string;
  pageIdentitySource: string;
  readOnly?: boolean;
  selectors: string;
  toggleStateFunction: string;
  waitForInCallMs: number;
};

const TEAMS_MEETING_TRANSCRIPT_MAX_LINES = 500;

export function teamsMeetingStatusPreludeSource(params: TeamsMeetingStatusPreludeParams): string {
  const selectors = params.selectors;
  const expectedIdentity = params.expectedIdentity;
  const toggleStateFunction = params.toggleStateFunction;
  const pageIdentityFunctionSource = () => params.pageIdentitySource;
  return `async () => {
  ${pageIdentityFunctionSource()}
  const parseToggleState = ${toggleStateFunction};
  const selectors = ${selectors};
  const expectedIdentity = ${JSON.stringify(expectedIdentity)};
  const allowMicrophone = ${JSON.stringify(params.allowMicrophone)};
  const allowSessionAdoption = ${JSON.stringify(params.allowSessionAdoption)};
  const autoJoin = ${JSON.stringify(params.autoJoin)};
  const captureCaptions = ${JSON.stringify(params.captureCaptions)};
  const readOnly = ${JSON.stringify(Boolean(params.readOnly))};
  const sessionId = ${JSON.stringify(params.meetingSessionId)};
  const identityRetentionMs = ${JSON.stringify(Math.max(30_000, params.waitForInCallMs))};
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const label = (node) => [
    node?.getAttribute?.("aria-label"),
    node?.getAttribute?.("title"),
    node?.getAttribute?.("data-tid"),
    text(node),
  ].filter(Boolean).join(" ");
  const clickable = (node) => node?.matches?.("button")
    ? node
    : node?.querySelector?.("button") || node?.closest?.("button") || node;
  const first = (list) => {
    for (const selector of list) {
      const node = document.querySelector(selector);
      if (node) return clickable(node);
    }
    return undefined;
  };
  const firstRaw = (list) => {
    for (const selector of list) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return undefined;
  };
  const firstWithin = (root, list) => {
    if (!root) return undefined;
    for (const selector of list) {
      if (root.matches?.(selector)) return root;
      const node = root.querySelector?.(selector);
      if (node) return node;
    }
    return undefined;
  };
  const buttons = [...document.querySelectorAll("button")];
  const findTextButton = (pattern) => buttons.find((button) => !button.disabled && pattern.test(label(button)));
  const waitForUi = () => new Promise((resolve) => setTimeout(resolve, 120));
  const bridgeOwnedBySession = (entry) => Boolean(
    sessionId && (!entry?.sessionId || entry.sessionId === sessionId)
  );
  const mediaSourceUrl = (element) => String(element?.currentSrc || element?.src || "");
  const bridgeSources = (entry) => Array.isArray(entry?.sources)
    ? entry.sources
    : entry?.source
      ? [{ element: entry.source, muted: Boolean(entry.sourceMuted), pending: Boolean(entry.pending), stream: entry.stream, url: entry.sourceUrl }]
      : [];
  const bridgeSourceMatches = (element, source) => {
    if (!element) return false;
    if (source?.pending && mediaSourceIsEmpty(element) && !source.stream && !source.url) return true;
    if (source?.stream || element.srcObject) return element.srcObject === source?.stream;
    const currentUrl = mediaSourceUrl(element);
    return Boolean(source?.url && currentUrl && source.url === currentUrl);
  };
  const mediaSourceIsEmpty = (element) => Boolean(
    element && !element.srcObject && !mediaSourceUrl(element)
  );
  const restoreAudioBridgeSource = (source) => {
    const element = source?.element;
    // An empty element may receive a replacement source after cleanup. Keep it
    // silent because there is no source identity that is safe to restore.
    if (mediaSourceIsEmpty(element)) {
      element.muted = true;
      return;
    }
    // Teams reuses media elements across source changes. Restore only the exact
    // source this bridge muted.
    if (!bridgeSourceMatches(element, source)) return;
    const detachedLiveSource = Boolean(
      element.isConnected === false &&
      element.srcObject?.getAudioTracks?.().some((track) => track.readyState === "live")
    );
    if (detachedLiveSource) {
      element.muted = true;
      element.pause?.();
      element.srcObject = null;
      return;
    }
    element.muted = Boolean(source.muted);
  };
  const restoreAudioBridgeSources = (entry) => {
    bridgeSources(entry).forEach(restoreAudioBridgeSource);
  };
  const retireAudioBridge = (entry, restoreSources = true) => {
    if (restoreSources) restoreAudioBridgeSources(entry);
    entry?.bridge?.pause?.();
    if (entry?.bridge) entry.bridge.srcObject = null;
    entry?.bridge?.remove?.();
  };
  const retireOwnedAudioBridges = (restoreSources = true) => {
    const entries = Array.isArray(window.__openclawTeamsAudioOutputs)
      ? window.__openclawTeamsAudioOutputs
      : [];
    const retained = [];
    for (const entry of entries) {
      if (!bridgeOwnedBySession(entry)) {
        retained.push(entry);
        continue;
      }
      retireAudioBridge(entry, restoreSources);
    }
    if (retained.length > 0) window.__openclawTeamsAudioOutputs = retained;
    else delete window.__openclawTeamsAudioOutputs;
  };
  const adoptAudioBridgeSourcesForSession = () => {
    const entries = Array.isArray(window.__openclawTeamsAudioOutputs)
      ? window.__openclawTeamsAudioOutputs
      : [];
    const suspendedBySource = new Map();
    for (const entry of entries) {
      for (const source of bridgeSources(entry)) {
        if (!source?.element || suspendedBySource.has(source.element)) continue;
        if (!bridgeSourceMatches(source.element, source)) {
          restoreAudioBridgeSource(source);
          continue;
        }
        suspendedBySource.set(source.element, {
          sessionId,
          source: source.element,
          sourceMuted: Boolean(source.muted),
          sourceUrl: mediaSourceUrl(source.element) || source.url,
          stream: source.element.srcObject,
          suspended: true,
        });
      }
      retireAudioBridge(entry, false);
    }
    const suspended = [...suspendedBySource.values()];
    if (suspended.length > 0) window.__openclawTeamsAudioOutputs = suspended;
    else delete window.__openclawTeamsAudioOutputs;
  };
  const suspendOwnedAudioBridges = () => {
    const entries = Array.isArray(window.__openclawTeamsAudioOutputs)
      ? window.__openclawTeamsAudioOutputs
      : [];
    const retained = [];
    const suspendedBySource = new Map();
    for (const entry of entries) {
      if (!bridgeOwnedBySession(entry)) {
        retained.push(entry);
        continue;
      }
      // This pending entry owns the muted element until a later serialized
      // status poll sees and routes the attached playback source.
      if (
        entry?.pending &&
        bridgeSources(entry).some((source) => bridgeSourceMatches(source?.element, source))
      ) {
        retained.push(entry);
        continue;
      }
      for (const source of bridgeSources(entry)) {
        if (!source?.element || suspendedBySource.has(source.element)) continue;
        if (!bridgeSourceMatches(source.element, source)) {
          restoreAudioBridgeSource(source);
          continue;
        }
        suspendedBySource.set(source.element, {
          sessionId: entry.sessionId || sessionId,
          source: source.element,
          sourceMuted: Boolean(source.muted),
          sourceUrl: source.url,
          stream: source.element.srcObject,
          suspended: true,
        });
      }
      retireAudioBridge(entry, false);
    }
    const next = [...retained, ...suspendedBySource.values()];
    if (next.length > 0) window.__openclawTeamsAudioOutputs = next;
    else delete window.__openclawTeamsAudioOutputs;
  };
  const retireOwnedCaptions = () => {
    const active = window.__openclawTeamsCaptions;
    const owned = Boolean(
      active && sessionId && (!active.sessionId || active.sessionId === sessionId)
    );
    if (!owned) return;
    if (active.settleTimer !== undefined) clearTimeout(active.settleTimer);
    active.observer?.disconnect?.();
    delete window.__openclawTeamsCaptions;
  };
  const finalizeCaptionState = (active) => {
    if (!active) return;
    if (active.settleTimer !== undefined) clearTimeout(active.settleTimer);
    active.settleTimer = undefined;
    active.observer?.disconnect?.();
    active.observer = undefined;
    active.observerInstalled = false;
    active.lines = Array.isArray(active.lines) ? active.lines : [];
    if (Array.isArray(active.visible) && active.visible.length > 0) {
      active.lines.push(...active.visible.map((entry) => ({
        at: entry.at,
        speaker: entry.speaker,
        text: entry.text,
      })));
      active.visible = [];
    }
    const excess = active.lines.length - ${TEAMS_MEETING_TRANSCRIPT_MAX_LINES};
    if (excess > 0) {
      active.lines.splice(0, excess);
      active.droppedLines = (active.droppedLines || 0) + excess;
    }
    active.finalized = true;
    active.finalizedAt = Date.now();
  };
  const archiveFinalizedCaptions = (active) => {
    if (active?.finalized !== true || !active.sessionId) return;
    const archive = window.__openclawTeamsCaptionArchive &&
        typeof window.__openclawTeamsCaptionArchive === "object"
      ? window.__openclawTeamsCaptionArchive
      : {};
    archive[active.sessionId] = active;
    const retained = Object.entries(archive)
      .sort((left, right) => Number(right[1]?.finalizedAt || 0) - Number(left[1]?.finalizedAt || 0))
      .slice(0, 4);
    window.__openclawTeamsCaptionArchive = Object.fromEntries(retained);
  };
  const finalizeOwnedCaptions = () => {
    const active = window.__openclawTeamsCaptions;
    const owned = Boolean(
      active && sessionId && (!active.sessionId || active.sessionId === sessionId)
    );
    if (owned) {
      active.identity ||= priorMeeting?.identity || expectedIdentity;
      finalizeCaptionState(active);
    }
  };
  const toggleState = (node, kind) => parseToggleState({
    kind,
    ariaPressed: node?.getAttribute?.("aria-pressed"),
    ariaChecked: node?.getAttribute?.("aria-checked"),
    checked: typeof node?.checked === "boolean" ? node.checked : undefined,
    label: label(node),
  });
  const notes = [];
  const currentIdentity = meetingIdentity(location.href);
  const priorMeeting = window.__openclawTeamsMeeting;
  if (expectedIdentity && currentIdentity && currentIdentity !== expectedIdentity) {
    // A confirmed SPA transition must stop resources still owned by this
    // request, while preserving any newer session already committed to the tab.
    retireOwnedAudioBridges();
    finalizeOwnedCaptions();
    const requestOwnsMeeting = Boolean(
      priorMeeting &&
      sessionId &&
      (!priorMeeting.sessionId || priorMeeting.sessionId === sessionId)
    );
    if (requestOwnsMeeting) delete window.__openclawTeamsMeeting;
    return JSON.stringify({
      inCall: false,
      manualActionRequired: true,
      manualActionReason: "teams-session-conflict",
      manualActionMessage: "The tracked Teams tab now shows a different meeting. Return to the requested meeting link, then retry.",
      title: document.title,
      url: location.href,
      notes,
    });
  }
  const meetingOwnerConflict = Boolean(
    priorMeeting?.sessionId && priorMeeting.sessionId !== sessionId
  );
  const captionOwnerConflict = Boolean(
    window.__openclawTeamsCaptions?.sessionId &&
    window.__openclawTeamsCaptions.sessionId !== sessionId
  );
  const committedOwnerConflict = meetingOwnerConflict || captionOwnerConflict;
  const canRepairCaptionOwner = Boolean(
    !meetingOwnerConflict && priorMeeting?.sessionId === sessionId
  );
  const canMutateSession = Boolean(
    !readOnly &&
    sessionId &&
    (!committedOwnerConflict || canRepairCaptionOwner || allowSessionAdoption)
  );
  const identityMatchedUrl = Boolean(expectedIdentity && currentIdentity === expectedIdentity);
  const identityVerifiedBeforeCall = identityMatchedUrl;
  const continueInBrowser = first(selectors.continueInBrowser) ||
    findTextButton(/continue on this browser|join on the web|use the web app|continue without the app/i);
  if (canMutateSession && identityVerifiedBeforeCall && continueInBrowser) {
    continueInBrowser.click();
    notes.push("Continued to the Teams web client.");
    await waitForUi();
  }
  const guestInput = first(selectors.guestName) || [...document.querySelectorAll("input")].find((input) =>
    /enter your name|type your name|your name|display name/i.test(label(input) + " " + (input.placeholder || ""))
  );
  if (canMutateSession && identityVerifiedBeforeCall && autoJoin && guestInput && !guestInput.value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    guestInput.focus();
    if (setter) setter.call(guestInput, ${JSON.stringify(params.guestName)});
    else guestInput.value = ${JSON.stringify(params.guestName)};
    guestInput.dispatchEvent(new Event("input", { bubbles: true }));
    guestInput.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const leave = first(selectors.leave);
  const continueWithoutDevices = findTextButton(/^continue without audio or video$/i);
  let dismissedDevicePrompt = false;
  if (
    canMutateSession &&
    identityVerifiedBeforeCall &&
    !leave &&
    autoJoin &&
    !allowMicrophone &&
    continueWithoutDevices
  ) {
    continueWithoutDevices.click();
    dismissedDevicePrompt = true;
    notes.push("Dismissed the Teams device prompt; selected audio is verified separately.");
    await waitForUi();
  }
  // Teams replaces the meeting URL after admission. Preserve identity only
  // while adopting the first in-call control or retaining that exact control.
  const markerAgeMs = Date.now() - (priorMeeting?.verifiedAt || 0);
  const identityAdoptedInCall = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    !priorMeeting?.inCallControl &&
    markerAgeMs >= 0 &&
    markerAgeMs < identityRetentionMs &&
    leave &&
    leave.isConnected !== false
  );
  const identityRerenderedInCall = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    priorMeeting?.inCallControl &&
    priorMeeting.inCallControl !== leave &&
    priorMeeting.inCallControl.isConnected === false &&
    priorMeeting?.inCallUrl === location.href &&
    markerAgeMs >= 0 &&
    markerAgeMs < 5_000 &&
    leave &&
    leave.isConnected !== false
  );
  const identityAwaitingRerender = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    priorMeeting?.inCallControl &&
    priorMeeting.inCallControl.isConnected === false &&
    priorMeeting?.inCallUrl === location.href &&
    markerAgeMs >= 0 &&
    markerAgeMs < 5_000 &&
    !leave
  );
  const identityPreservedInCall = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    leave &&
    leave.isConnected !== false &&
    (
      identityAdoptedInCall ||
      identityRerenderedInCall ||
      (
        priorMeeting?.inCallControl === leave &&
        priorMeeting?.inCallUrl === location.href
      )
    )
  );
  const identityVerified = identityVerifiedBeforeCall || identityPreservedInCall;
  const inCall = Boolean(identityVerified && leave);
  if (canMutateSession && identityVerified && meetingOwnerConflict) {
    // The tab can survive a Teams SPA meeting/session change. Old hidden bridges
    // must stop, while their muted source streams remain eligible for the new owner.
    adoptAudioBridgeSourcesForSession();
  }
  if (canMutateSession && !inCall && !identityAwaitingRerender) retireOwnedAudioBridges();
  if (canMutateSession && (identityVerifiedBeforeCall || identityPreservedInCall)) {
    window.__openclawTeamsMeeting = {
      ...(priorMeeting?.identity === expectedIdentity && !meetingOwnerConflict ? priorMeeting : {}),
      identity: expectedIdentity,
      sessionId: sessionId || priorMeeting?.sessionId,
      verifiedAt: Date.now(),
      ...(inCall ? { inCallControl: leave, inCallUrl: location.href } : {}),
    };
  } else if (
    canMutateSession &&
    !currentIdentity &&
    priorMeeting &&
    !identityAwaitingRerender &&
    (priorMeeting.inCallControl || markerAgeMs >= identityRetentionMs)
  ) {
    delete window.__openclawTeamsMeeting;
  }
  const microphone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
  let microphoneState = identityVerified ? toggleState(microphone, "microphone") : undefined;
  const camera = first(selectors.camera) || findTextButton(/camera|video/i);
  let cameraState = identityVerified ? toggleState(camera, "camera") : undefined;
  let controlManualActionReason;
  let controlManualActionMessage;
  if (canMutateSession && identityVerified && !inCall && camera && cameraState === "on") {
    camera.click();
    await waitForUi();
    const currentCamera = first(selectors.camera) || findTextButton(/camera|video/i);
    cameraState = toggleState(currentCamera, "camera");
    if (cameraState === "off") {
      notes.push("Turned the Teams camera off before joining.");
    }
  }
  const join = first(selectors.join) || findTextButton(/^\\s*(join now|ask to join|join meeting)\\s*$/i);
  if (identityVerified && !inCall && join && cameraState !== "off") {
    controlManualActionReason = "teams-camera-required";
    controlManualActionMessage = "Turn the Teams camera off and verify the camera control shows it is off, then retry joining.";
  }
  const isBlackHole = (value) =>
    /^blackhole 2ch(?: \\(virtual\\))?$/i.test(String(value || "").replace(/\\s+/g, " ").trim());
  const isBlackHoleNode = (node) => [
    node?.getAttribute?.("aria-label"),
    node?.getAttribute?.("title"),
    node?.label,
    node?.value,
    text(node),
  ].some(isBlackHole);
  const microphoneDeviceRoots = () => {
    // Consumer in-call controls expose the listbox itself, without the prejoin
    // selected-device button/combobox wrapper.
    const control = firstRaw(selectors.microphoneDevice) || firstRaw(selectors.microphoneDeviceMenu);
    if (!control) return { control, roots: [] };
    const roots = [control];
    const scope = control.closest?.('[data-tid="device-settings-microphone"]');
    if (scope && !roots.includes(scope)) roots.push(scope);
    const listboxId = control.getAttribute?.("aria-controls");
    const listbox = listboxId ? document.getElementById?.(listboxId) : undefined;
    if (listbox && !roots.includes(listbox)) roots.push(listbox);
    const liveMenu = firstRaw(selectors.microphoneDeviceMenu);
    if (liveMenu && !roots.includes(liveMenu)) roots.push(liveMenu);
    return { control, roots };
  };
  const selectedMicrophoneLabel = () => {
    const { control, roots } = microphoneDeviceRoots();
    const selectedOption = control?.selectedOptions?.[0];
    if (selectedOption && isBlackHoleNode(selectedOption)) {
      return label(selectedOption) || selectedOption.value;
    }
    if (control && isBlackHoleNode(control)) return label(control) || control.value;
    for (const root of roots) {
      const selected = firstWithin(root, selectors.selectedMicrophoneDevice);
      if (selected && isBlackHoleNode(selected)) {
        return label(selected) || selected.value;
      }
    }
    return undefined;
  };
  let audioInputRouted;
  let audioInputDeviceLabel;
  let audioInputRouteError;
  const ensureVirtualAudioInput = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const input = devices.find((device) => device.kind === "audioinput" && isBlackHole(device.label));
      if (!input?.deviceId) return false;
      audioInputDeviceLabel = input.label || "BlackHole 2ch";
      // Teams hides the selected-device control after admission. Reopen the in-call audio
      // options and verify the current selection before unmuting; installed devices alone
      // do not prove which microphone Teams is using.
      const preparedInput = window.__openclawTeamsMeeting;
      const preparedSelection = Boolean(
        readOnly &&
        preparedInput?.identity === expectedIdentity &&
        (!sessionId || preparedInput?.sessionId === sessionId) &&
        preparedInput?.audioInputDeviceId === input.deviceId
      );
      let selected = Boolean(selectedMicrophoneLabel()) || preparedSelection;
      if (!selected && canMutateSession) {
        const settings = first(selectors.deviceSettings);
        if (settings) {
          settings.click();
          await waitForUi();
        }
        const { control } = microphoneDeviceRoots();
        if (control?.tagName?.toLowerCase() === "select") {
          const options = [...control.options];
          const option = options.find(isBlackHoleNode);
          if (option) {
            control.value = option.value;
            control.dispatchEvent(new Event("change", { bubbles: true }));
            await waitForUi();
          }
        } else if (control) {
          clickable(control)?.click?.();
          await waitForUi();
        }
        const choices = microphoneDeviceRoots().roots.flatMap((root) =>
          selectors.audioDeviceOptions.flatMap((selector) => [
            ...(root.querySelectorAll?.(selector) || []),
          ])
        );
        const choice = choices.find(isBlackHoleNode);
        if (choice && choice.getAttribute?.("aria-selected") !== "true") {
          clickable(choice)?.click?.();
          await waitForUi();
        }
        selected = Boolean(selectedMicrophoneLabel());
      }
      if (selected && window.__openclawTeamsMeeting?.identity === expectedIdentity) {
        window.__openclawTeamsMeeting.audioInputDeviceId = input.deviceId;
      }
      return selected;
    } catch (error) {
      audioInputRouteError = error?.message || String(error);
      return false;
    }
  };
  if (identityVerified && !inCall && allowMicrophone && microphone) {
    audioInputRouted = await ensureVirtualAudioInput();
    if (!audioInputRouted) {
      if (canMutateSession && microphoneState === "on") {
        microphone.click();
        await waitForUi();
        const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
        microphoneState = toggleState(currentMicrophone, "microphone");
      }
      controlManualActionReason = "teams-audio-choice-required";
      controlManualActionMessage = "Select BlackHole 2ch as the Teams microphone and verify it is selected before enabling talk-back.";
    } else if (canMutateSession && microphoneState === "off") {
      microphone.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
      if (microphoneState === "on") {
        notes.push("Unmuted the Teams microphone after verifying BlackHole 2ch input.");
      }
    }
    if (audioInputRouted && microphoneState !== "on") {
      controlManualActionReason = "teams-microphone-required";
      controlManualActionMessage = "Unmute the Teams microphone and verify the microphone control shows it is on, then retry joining.";
    }
  } else if (canMutateSession && identityVerified && !inCall && !allowMicrophone && microphoneState === "on") {
      microphone.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
      if (microphoneState === "off") {
        notes.push("Muted the Teams microphone for observe-only mode.");
      }
  }
  if (identityVerified && inCall && allowMicrophone) {
    if (!selectedMicrophoneLabel() && canMutateSession && microphoneState === "on") {
      microphone?.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
    }
    audioInputRouted = await ensureVirtualAudioInput();
    if (audioInputRouted && canMutateSession && microphoneState === "off") {
      microphone?.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
    } else if (!audioInputRouted && canMutateSession && microphoneState === "on") {
      microphone?.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
      if (microphoneState === "off") {
        notes.push("Muted the Teams microphone because BlackHole 2ch input could not be reverified.");
      }
    }
  }
  if (identityVerified && !inCall && join && !allowMicrophone && microphoneState !== "off") {
    controlManualActionReason = "teams-microphone-required";
    controlManualActionMessage = "Mute the Teams microphone and verify the microphone control shows it is off, then retry joining.";
  }
  if (identityVerified && !inCall && join && allowMicrophone && !controlManualActionReason) {
    if (!microphone) {
      controlManualActionReason = "teams-microphone-required";
      controlManualActionMessage = "Open Teams device settings and verify the microphone control before enabling talk-back.";
    } else if (audioInputRouted !== true) {
      controlManualActionReason = "teams-audio-choice-required";
      controlManualActionMessage = "Select BlackHole 2ch as the Teams microphone and verify it is selected before enabling talk-back.";
    } else if (microphoneState !== "on") {
      controlManualActionReason = "teams-microphone-required";
      controlManualActionMessage = "Unmute the Teams microphone and verify the microphone control shows it is on, then retry joining.";
    }
  }
  const micMuted = microphoneState === "off" ? true : microphoneState === "on" ? false : undefined;
  const cameraOff = cameraState === "off" ? true : cameraState === "on" ? false : undefined;
  const pageText = text(document.body);
  const pageTextLower = pageText.toLowerCase();
  const lobbyWaiting = Boolean(first(selectors.lobby)) ||
    /someone will let you in shortly|waiting for someone to let you in|when someone admits you|you.?re in the lobby|we.?ve let people in the meeting know you.?re waiting/i.test(pageTextLower);
  const signInControl = first(selectors.signIn);
  const hostname = location.hostname.toLowerCase();
  const tenantLoginRequired =
    /only people with a work or school account|sign in with an account from this organization|anonymous users (?:can.?t|cannot) join|verify your email|enter the code sent to/i.test(pageTextLower);
  const loginRequired = hostname === "login.microsoftonline.com" ||
    hostname.endsWith(".microsoftonline.com") ||
    tenantLoginRequired ||
    (Boolean(signInControl) && !guestInput && !join && /sign in to (?:join|continue)|sign in to your account/i.test(pageTextLower));
  let microphonePermissionState;
  if (allowMicrophone && navigator.permissions?.query) {
    try {
      microphonePermissionState = (await navigator.permissions.query({ name: "microphone" })).state;
    } catch {}
  }
  const devicePermissionPrompt = !dismissedDevicePrompt && Boolean(
    first(selectors.permissionPrompt) || continueWithoutDevices
  );
  // Teams shows the same no-audio/video warning when only camera access is denied.
  // A granted microphone plus the verified BlackHole input is sufficient for talk-back.
  const permissionRequired = devicePermissionPrompt &&
    (!allowMicrophone || microphonePermissionState !== "granted");
  let manualActionReason;
  let manualActionMessage;
  if (committedOwnerConflict && !canMutateSession) {
    manualActionReason = "teams-session-conflict";
    manualActionMessage = "This Teams tab is owned by another active meeting session.";
  } else if (!inCall && loginRequired) {
    manualActionReason = "teams-login-required";
    manualActionMessage = tenantLoginRequired
      ? "This Teams tenant requires sign-in or email verification. Complete it in the OpenClaw browser profile, then retry."
      : "Sign in to Microsoft Teams in the OpenClaw browser profile, then retry the meeting join.";
  } else if (!inCall && lobbyWaiting) {
    manualActionReason = "teams-admission-required";
    manualActionMessage = "Admit the OpenClaw guest from the Microsoft Teams lobby, then retry speech.";
  } else if (!inCall && permissionRequired) {
    manualActionReason = "teams-permission-required";
    manualActionMessage = allowMicrophone
      ? "Allow microphone permission for Teams in the OpenClaw browser profile, then retry."
      : "Dismiss the Teams device-permission prompt or continue without devices, then retry.";
  } else if (!inCall && controlManualActionReason) {
    manualActionReason = controlManualActionReason;
    manualActionMessage = controlManualActionMessage;
  }
  let clickedJoin = false;
  if (canMutateSession && identityVerified && autoJoin && !inCall && join && !join.disabled && !manualActionReason) {
    join.click();
    clickedJoin = true;
    notes.push("Clicked the Teams guest join button.");
  }
`;
}
