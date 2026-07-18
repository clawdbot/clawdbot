import { TEAMS_MEETING_SELECTORS } from "./teams-meetings-selectors.js";
import { normalizeTeamsMeetingUrlForReuse } from "./teams-meetings-urls.js";

function pageIdentityFunctionSource(): string {
  return `const meetingIdentity = (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== "https:") return undefined;
      if (host === "teams.microsoft.com") {
        const match = parsed.pathname.match(/^\\/l\\/meetup-join\\/([^/]+)(?:\\/0)?\\/?$/i);
        if (!match?.[1]) return undefined;
        const threadId = decodeURIComponent(match[1]);
        return /^19:[^/]+@thread\\.(?:v2|tacv2)$/i.test(threadId)
          ? "teams-work:" + threadId
          : undefined;
      }
      if (host === "teams.live.com") {
        const match = parsed.pathname.match(/^\\/meet\\/([^/]+)\\/?$/i);
        if (!match?.[1]) return undefined;
        const code = decodeURIComponent(match[1]);
        const password = parsed.searchParams.get("p");
        return /^[a-z0-9_-]+$/i.test(code)
          ? "teams-consumer:" + code.toLowerCase() + ":p:" + encodeURIComponent(password || "")
          : undefined;
      }
    } catch {}
    return undefined;
  };`;
}

function teamsMeetingToggleStateFunctionSource(): string {
  return `(input) => {
    const pressed = String(input?.ariaPressed || "").toLowerCase();
    if (pressed === "true") return "on";
    if (pressed === "false") return "off";
    const value = String(input?.label || "").toLowerCase().replace(/\\s+/g, " ").trim();
    if (!value) return undefined;
    if (input?.kind === "camera") {
      if (/\\bturn (?:your )?camera off\\b|\\bturn off (?:your )?camera\\b|\\bstop video\\b|\\bdisable (?:your )?(?:camera|video)\\b/.test(value)) return "on";
      if (/\\bturn (?:your )?camera on\\b|\\bturn on (?:your )?camera\\b|\\bstart video\\b|\\benable (?:your )?(?:camera|video)\\b/.test(value)) return "off";
      if (/\\b(?:camera|video) (?:is |currently )?(?:off|disabled)\\b/.test(value)) return "off";
      if (/\\b(?:camera|video) (?:is |currently )?(?:on|enabled)\\b/.test(value)) return "on";
      return undefined;
    }
    if (/^mute$|\\bturn (?:your )?(?:microphone|mic) off\\b|\\bturn off (?:your )?(?:microphone|mic)\\b|\\bmute (?:your )?(?:microphone|mic)\\b|\\bdisable (?:your )?(?:microphone|mic)\\b/.test(value)) return "on";
    if (/^unmute$|\\bturn (?:your )?(?:microphone|mic) on\\b|\\bturn on (?:your )?(?:microphone|mic)\\b|\\bunmute (?:your )?(?:microphone|mic)\\b|\\benable (?:your )?(?:microphone|mic)\\b/.test(value)) return "off";
    if (/\\b(?:microphone|mic) (?:is |currently )?(?:off|muted|disabled)\\b/.test(value)) return "off";
    if (/\\b(?:microphone|mic) (?:is |currently )?(?:on|unmuted|enabled)\\b/.test(value)) return "on";
    return undefined;
  }`;
}

export function teamsMeetingStatusScript(params: {
  allowMicrophone: boolean;
  autoJoin: boolean;
  guestName: string;
  meetingSessionId?: string;
  meetingUrl: string;
  readOnly?: boolean;
}) {
  const selectors = JSON.stringify(TEAMS_MEETING_SELECTORS);
  const expectedIdentity = normalizeTeamsMeetingUrlForReuse(params.meetingUrl);
  const toggleStateFunction = teamsMeetingToggleStateFunctionSource();
  return `async () => {
  ${pageIdentityFunctionSource()}
  const parseToggleState = ${toggleStateFunction};
  const selectors = ${selectors};
  const expectedIdentity = ${JSON.stringify(expectedIdentity)};
  const allowMicrophone = ${JSON.stringify(params.allowMicrophone)};
  const autoJoin = ${JSON.stringify(params.autoJoin)};
  const readOnly = ${JSON.stringify(Boolean(params.readOnly))};
  const sessionId = ${JSON.stringify(params.meetingSessionId)};
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
  const toggleState = (node, kind) => parseToggleState({
    kind,
    ariaPressed: node?.getAttribute?.("aria-pressed"),
    label: label(node),
  });
  const notes = [];
  const currentIdentity = meetingIdentity(location.href);
  const priorMeeting = window.__openclawTeamsMeeting;
  if (expectedIdentity && currentIdentity && currentIdentity !== expectedIdentity) {
    delete window.__openclawTeamsMeeting;
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
  const identityMatchedUrl = Boolean(expectedIdentity && currentIdentity === expectedIdentity);
  const continueInBrowser = first(selectors.continueInBrowser) ||
    findTextButton(/continue on this browser|join on the web|use the web app|continue without the app/i);
  if (!readOnly && identityMatchedUrl && continueInBrowser) {
    continueInBrowser.click();
    notes.push("Continued to the Teams web client.");
    await waitForUi();
  }
  const guestInput = first(selectors.guestName) || [...document.querySelectorAll("input")].find((input) =>
    /enter your name|type your name|your name|display name/i.test(label(input) + " " + (input.placeholder || ""))
  );
  if (!readOnly && identityMatchedUrl && autoJoin && guestInput && !guestInput.value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    guestInput.focus();
    if (setter) setter.call(guestInput, ${JSON.stringify(params.guestName)});
    else guestInput.value = ${JSON.stringify(params.guestName)};
    guestInput.dispatchEvent(new Event("input", { bubbles: true }));
    guestInput.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const leave = first(selectors.leave);
  // Teams replaces the meeting URL after admission. Preserve identity only
  // while adopting the first in-call control or retaining that exact control.
  const markerAgeMs = Date.now() - (priorMeeting?.verifiedAt || 0);
  const identityAdoptedInCall = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    !priorMeeting?.inCallControl &&
    markerAgeMs >= 0 &&
    markerAgeMs < 30_000 &&
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
  const identityVerified = identityMatchedUrl || identityPreservedInCall;
  const inCall = Boolean(identityVerified && leave);
  if (identityMatchedUrl || identityPreservedInCall) {
    window.__openclawTeamsMeeting = {
      ...(priorMeeting?.identity === expectedIdentity ? priorMeeting : {}),
      identity: expectedIdentity,
      sessionId: sessionId || priorMeeting?.sessionId,
      verifiedAt: Date.now(),
      ...(inCall ? { inCallControl: leave, inCallUrl: location.href } : {}),
    };
  } else if (
    !currentIdentity &&
    priorMeeting &&
    !identityAwaitingRerender &&
    (priorMeeting.inCallControl || markerAgeMs >= 30_000)
  ) {
    delete window.__openclawTeamsMeeting;
  }
  const microphone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
  let microphoneState = identityVerified ? toggleState(microphone, "microphone") : undefined;
  const camera = first(selectors.camera) || findTextButton(/camera|video/i);
  let cameraState = identityVerified ? toggleState(camera, "camera") : undefined;
  let controlManualActionReason;
  let controlManualActionMessage;
  if (!readOnly && identityVerified && !inCall && camera && cameraState === "on") {
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
    String(value || "").replace(/\\s+/g, " ").trim().toLowerCase() === "blackhole 2ch";
  const isBlackHoleNode = (node) => [
    node?.getAttribute?.("aria-label"),
    node?.getAttribute?.("title"),
    node?.label,
    node?.value,
    text(node),
  ].some(isBlackHole);
  const microphoneDeviceRoots = () => {
    const control = firstRaw(selectors.microphoneDevice);
    if (!control) return { control, roots: [] };
    const roots = [control];
    const scope = control.closest?.('[data-tid="device-settings-microphone"]');
    if (scope && !roots.includes(scope)) roots.push(scope);
    const listboxId = control.getAttribute?.("aria-controls");
    const listbox = listboxId ? document.getElementById?.(listboxId) : undefined;
    if (listbox && !roots.includes(listbox)) roots.push(listbox);
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
      let selected = Boolean(selectedMicrophoneLabel());
      if (!selected && !readOnly) {
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
      if (!readOnly && microphoneState === "on") {
        microphone.click();
        await waitForUi();
        const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
        microphoneState = toggleState(currentMicrophone, "microphone");
      }
      controlManualActionReason = "teams-audio-choice-required";
      controlManualActionMessage = "Select BlackHole 2ch as the Teams microphone and verify it is selected before enabling talk-back.";
    } else if (!readOnly && microphoneState === "off") {
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
  } else if (!readOnly && identityVerified && !inCall && !allowMicrophone && microphoneState === "on") {
      microphone.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
      if (microphoneState === "off") {
        notes.push("Muted the Teams microphone for observe-only mode.");
      }
  }
  if (identityVerified && inCall && allowMicrophone) {
    if (!selectedMicrophoneLabel() && !readOnly && microphoneState === "on") {
      microphone?.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
    }
    audioInputRouted = await ensureVirtualAudioInput();
    if (audioInputRouted && !readOnly && microphoneState === "off") {
      microphone?.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
    } else if (!audioInputRouted && !readOnly && microphoneState === "on") {
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
  const permissionRequired = Boolean(first(selectors.permissionPrompt));
  let manualActionReason;
  let manualActionMessage;
  if (!inCall && loginRequired) {
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
      ? "Allow microphone and camera permissions for Teams in the OpenClaw browser profile, then retry."
      : "Dismiss the Teams device-permission prompt or continue without devices, then retry.";
  } else if (!inCall && controlManualActionReason) {
    manualActionReason = controlManualActionReason;
    manualActionMessage = controlManualActionMessage;
  }
  let clickedJoin = false;
  if (!readOnly && identityVerified && autoJoin && !inCall && join && !join.disabled && !manualActionReason) {
    join.click();
    clickedJoin = true;
    notes.push("Clicked the Teams guest join button.");
  }
  let audioOutputRouted;
  let audioOutputDeviceLabel;
  let audioOutputRouteError;
  if (inCall && allowMicrophone && navigator.mediaDevices?.enumerateDevices) {
    const media = [...document.querySelectorAll("audio, video")].filter((element) =>
      typeof element.setSinkId === "function"
    );
    if (media.length > 0) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const output = devices.find((device) => device.kind === "audiooutput" && isBlackHole(device.label));
        if (output?.deviceId) {
          for (const element of media) {
            if (!readOnly && element.sinkId !== output.deviceId) await element.setSinkId(output.deviceId);
          }
          audioOutputRouted = media.some((element) => element.sinkId === output.deviceId);
          audioOutputDeviceLabel = output.label || "BlackHole 2ch";
        } else {
          audioOutputRouted = false;
          notes.push("BlackHole 2ch speaker output was not visible to Teams.");
        }
      } catch (error) {
        audioOutputRouted = false;
        audioOutputRouteError = error?.message || String(error);
        notes.push("Could not route Teams speaker output to BlackHole 2ch: " + audioOutputRouteError);
      }
    } else {
      audioOutputRouted = false;
    }
  }
  if (inCall && allowMicrophone) {
    if (audioInputRouted !== true || audioOutputRouted !== true) {
      manualActionReason = "teams-audio-choice-required";
      manualActionMessage = "Verify BlackHole 2ch is selected as both the Teams microphone and speaker before starting talk-back.";
    } else if (micMuted !== false) {
      manualActionReason = "teams-microphone-required";
      manualActionMessage = "Unmute the Teams microphone and verify the microphone control shows it is on before starting talk-back.";
    }
  }
  return JSON.stringify({
    clickedContinueInBrowser: Boolean(continueInBrowser),
    clickedJoin,
    inCall,
    micMuted,
    cameraOff,
    lobbyWaiting,
    audioInputRouted,
    audioInputDeviceLabel,
    audioInputRouteError,
    audioOutputRouted,
    audioOutputDeviceLabel,
    audioOutputRouteError,
    manualActionRequired: Boolean(manualActionReason),
    manualActionReason,
    manualActionMessage,
    title: document.title,
    url: location.href,
    notes,
  });
}`;
}

export function teamsMeetingTranscriptScript(meetingUrl: string, meetingSessionId: string) {
  const expectedIdentity = normalizeTeamsMeetingUrlForReuse(meetingUrl);
  return `() => {
  ${pageIdentityFunctionSource()}
  const expectedIdentity = ${JSON.stringify(expectedIdentity)};
  const expectedSessionId = ${JSON.stringify(meetingSessionId)};
  const currentIdentity = meetingIdentity(location.href);
  const state = window.__openclawTeamsMeeting;
  const effectiveIdentity = currentIdentity || state?.identity;
  if (!expectedIdentity || effectiveIdentity !== expectedIdentity) {
    return JSON.stringify({ urlMatched: false, droppedLines: 0, lines: [] });
  }
  if (state?.sessionId && state.sessionId !== expectedSessionId) {
    return JSON.stringify({ urlMatched: true, sessionMatched: false, droppedLines: 0, lines: [] });
  }
  return JSON.stringify({ urlMatched: true, sessionMatched: true, droppedLines: 0, lines: [] });
}`;
}

export function teamsMeetingLeaveScript(meetingUrl: string) {
  const selectors = JSON.stringify(TEAMS_MEETING_SELECTORS);
  const expectedIdentity = normalizeTeamsMeetingUrlForReuse(meetingUrl);
  return `() => {
  ${pageIdentityFunctionSource()}
  const selectors = ${selectors};
  const expectedIdentity = ${JSON.stringify(expectedIdentity)};
  const currentIdentity = meetingIdentity(location.href);
  const state = window.__openclawTeamsMeeting;
  const first = (list) => {
    for (const selector of list) {
      const node = document.querySelector(selector);
      if (!node) continue;
      return node.matches?.("button") ? node : node.querySelector?.("button") || node.closest?.("button") || node;
    }
    return undefined;
  };
  const leave = first(selectors.leave);
  const confirmation = first(selectors.leaveConfirmation);
  const postCall = first(selectors.postCall);
  const currentUrlMatches = Boolean(expectedIdentity && currentIdentity === expectedIdentity);
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
  if (
    !currentUrlMatches &&
    !preservedCallMatches &&
    !pendingLeaveMatches &&
    !rerenderPendingMatches
  ) {
    return JSON.stringify({ departed: false, urlMatched: false });
  }
  if (postCall) {
    delete window.__openclawTeamsMeeting;
    return JSON.stringify({ departed: true, urlMatched: true });
  }
  if (confirmation) {
    confirmation.click();
    return JSON.stringify({ departed: false, leaveAction: "confirm", urlMatched: true });
  }
  if (leave) {
    window.__openclawTeamsMeeting = {
      ...state,
      identity: expectedIdentity,
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
