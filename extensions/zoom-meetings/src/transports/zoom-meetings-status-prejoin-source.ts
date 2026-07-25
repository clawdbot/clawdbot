import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { zoomMeetingStatusAccessSource } from "./zoom-meetings-status-access-source.js";
import { zoomMeetingStatusPageSource } from "./zoom-meetings-status-page-source.js";

type MeetingStatusPreludeParams = Parameters<
  typeof MeetingPlatformAdapter.createStatusPreludeSource
>[0];

export function zoomMeetingStatusPreludeSource(params: MeetingStatusPreludeParams): string {
  return MeetingPlatformAdapter.createStatusPreludeSource(params, {
    controlLookupSource: `const findTextButton = (pattern) => [...document.querySelectorAll("button")]
    .find((button) => !button.disabled && pattern.test(label(button)));
  const findTextControl = (pattern) =>
    [...document.querySelectorAll('button, a, [role="button"]')]
      .find((control) => !control.disabled && pattern.test(label(control)));`,
    lifecycleSource: `  const continueInBrowser = first(selectors.continueInBrowser) ||
    findTextButton(/join from browser|continue on this browser|join on the web|use the web app|continue without the app/i);
  if (canMutateSession && identityVerifiedBeforeCall && continueInBrowser) {
    continueInBrowser.click();
    notes.push("Continued to the Zoom web client.");
    await waitForUi();
  }
  const guestInput = first(selectors.guestName) || [...document.querySelectorAll("input")].find((input) =>
    /enter your name|type your name|your name|display name/i.test(label(input) + " " + (input.placeholder || ""))
  );
  if (canMutateSession && identityVerifiedBeforeCall && autoJoin && guestInput && guestInput.value !== ${JSON.stringify(params.guestName)}) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    guestInput.focus();
    if (setter) setter.call(guestInput, ${JSON.stringify(params.guestName)});
    else guestInput.value = ${JSON.stringify(params.guestName)};
    guestInput.dispatchEvent(new Event("input", { bubbles: true }));
    guestInput.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const leave = first(selectors.leave);
  let continueWithoutDevices = findTextControl(/\\bcontinue without (?:audio or video|microphone(?: and camera)?)\\b/i);
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
    notes.push("Continued past the Zoom device prompt in observe-only mode.");
    await waitForUi();
    continueWithoutDevices = findTextControl(
      /\\bcontinue without (?:audio or video|microphone(?: and camera)?)\\b/i
    );
    if (continueWithoutDevices) {
      continueWithoutDevices.click();
      await waitForUi();
    }
  } else if (
    canMutateSession &&
    identityVerifiedBeforeCall &&
    !leave &&
    autoJoin &&
    allowMicrophone
  ) {
    const useMicrophone = document.querySelector('usermedia.pepc-permission-dialog__permission-button[type*="microphone"]');
    if (useMicrophone) {
      useMicrophone.click();
      notes.push("Requested Zoom microphone access from the prejoin prompt.");
      await waitForUi();
    }
  }
  ${zoomMeetingStatusPageSource()}
  const devicesDisabled = Boolean(!allowMicrophone && (dismissedDevicePrompt || (priorMeeting?.identity === expectedIdentity && (!sessionId || priorMeeting?.sessionId === sessionId) && priorMeeting?.devicesDisabled === true)));
  // Zoom replaces the meeting URL after admission; retain only an adopted in-call control.
  // Lobby ownership remains durable because host admission has no bounded wait.
  const markerAgeMs = Date.now() - (priorMeeting?.verifiedAt || 0);
  const inCallControlDisconnected = Boolean(!currentIdentity && priorMeeting?.identity === expectedIdentity && priorMeeting?.inCallControl?.isConnected === false);
  if (inCallControlDisconnected && !leave) priorMeeting.inCallControlLostAt ||= Date.now();
  const inCallControlLossAgeMs = Date.now() - (priorMeeting?.inCallControlLostAt || Date.now());
  const identityAdoptedInCall = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    !priorMeeting?.inCallControl &&
    (
      priorMeeting?.awaitingAdmission === true ||
      (markerAgeMs >= 0 && markerAgeMs < identityRetentionMs)
    ) &&
    leave &&
    leave.isConnected !== false
  );
  const identityRerenderedInCall = Boolean(
    inCallControlDisconnected &&
    priorMeeting.inCallControl !== leave &&
    priorMeeting?.inCallUrl === location.href &&
    leave &&
    leave.isConnected !== false
  );
  const identityAwaitingRerender = Boolean(
    inCallControlDisconnected &&
    inCallControlLossAgeMs >= 0 &&
    inCallControlLossAgeMs < 5_000 &&
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
  const meetingEnded = Boolean(
    [...document.querySelectorAll(".zm-modal-body-title")].some((node) =>
      /meeting (?:has been ended by host|has ended)/i.test(text(node))
    ) ||
    (
      inCallControlDisconnected &&
      inCallControlLossAgeMs >= 5_000 &&
      !leave
    )
  );
  const inCall = Boolean(identityVerified && leave && !meetingEnded);
  if (canMutateSession && identityVerified && meetingOwnerConflict) {
    // The tab can survive a Zoom SPA meeting/session change. Old hidden bridges
    // must stop, while their muted source streams remain eligible for the new owner.
    adoptAudioBridgeSourcesForSession();
  }
  if (canMutateSession && !inCall && !identityAwaitingRerender) retireOwnedAudioBridges();
  if (canMutateSession && (identityVerifiedBeforeCall || identityPreservedInCall)) {
    window.__openclawZoomMeeting = {
      ...(priorMeeting?.identity === expectedIdentity && !meetingOwnerConflict ? priorMeeting : {}),
      identity: expectedIdentity,
      sessionId: sessionId || priorMeeting?.sessionId,
      verifiedAt: Date.now(),
      awaitingAdmission: !inCall && lobbyWaiting,
      devicesDisabled,
      ...(inCall ? { inCallControl: leave, inCallControlLostAt: undefined, inCallUrl: location.href } : {}),
    };
  } else if (
    canMutateSession &&
    !currentIdentity &&
    priorMeeting &&
    !identityAwaitingRerender &&
    (
      priorMeeting.inCallControl ||
      (priorMeeting.awaitingAdmission !== true && markerAgeMs >= identityRetentionMs)
    )
  ) {
    delete window.__openclawZoomMeeting;
  }
  const microphone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
  let microphoneState = identityVerified ? (toggleState(microphone, "microphone") || (devicesDisabled ? "off" : undefined)) : undefined;
  const camera = first(selectors.camera) || findTextButton(/camera|video/i);
  let cameraState = identityVerified ? (toggleState(camera, "camera") || (devicesDisabled ? "off" : undefined)) : undefined;
  let controlManualActionReason;
  let controlManualActionMessage;
  ${zoomMeetingStatusAccessSource()}
  if (
    canMutateSession &&
    identityVerified &&
    camera &&
    cameraState === "on" &&
    !controlManualActionReason
  ) {
    camera.click();
    await waitForUi();
    const continueWithoutCamera = findTextControl(/\\bcontinue without camera\\b/i);
    if (continueWithoutCamera) {
      clickable(continueWithoutCamera)?.click?.();
      await waitForUi();
    }
    const currentCamera = first(selectors.camera) || findTextButton(/camera|video/i);
    cameraState = toggleState(currentCamera, "camera");
    if (cameraState === "off") {
      notes.push(inCall ? "Turned the Zoom camera off after admission." : "Turned the Zoom camera off before joining.");
    }
  }
  const join = first(selectors.join) ||
    findTextButton(/^\\s*(join|join now|ask to join|join meeting)\\s*$/i);
  if (
    identityVerified &&
    (inCall || join) &&
    cameraState !== "off" &&
    !controlManualActionReason
  ) {
    controlManualActionReason = "zoom-camera-required";
    controlManualActionMessage = inCall
      ? "Turn the Zoom camera off and verify the in-call camera control shows it is off."
      : "Turn the Zoom camera off and verify the camera control shows it is off, then retry joining.";
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
    const preparedInput = window.__openclawZoomMeeting;
    if (preparedInput?.identity === expectedIdentity && (!sessionId || preparedInput?.sessionId === sessionId)) {
      delete preparedInput.audioInputDeviceId;
    }
    if (!navigator.mediaDevices?.enumerateDevices) return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const input = devices.find((device) => device.kind === "audioinput" && isBlackHole(device.label));
      if (!input?.deviceId) return false;
      audioInputDeviceLabel = input.label || "BlackHole 2ch";
      // Zoom hides the selected-device control after admission. Reopen the in-call audio
      // options and verify the current selection before unmuting; installed devices alone
      // do not prove which microphone Zoom is using.
      let selected = Boolean(selectedMicrophoneLabel());
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
      notes.push("BlackHole input will be selected from Zoom's in-call audio controls.");
    } else if (canMutateSession && microphoneState === "off") {
      microphone.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
      if (microphoneState === "on") {
        notes.push("Unmuted the Zoom microphone after verifying BlackHole 2ch input.");
      }
    }
  } else if (canMutateSession && identityVerified && !allowMicrophone && microphoneState === "on") {
      microphone.click();
      await waitForUi();
      const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
      microphoneState = toggleState(currentMicrophone, "microphone");
      if (microphoneState === "off") {
        notes.push("Muted the Zoom microphone for observe-only mode.");
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
        notes.push("Muted the Zoom microphone because BlackHole 2ch input could not be reverified.");
      }
    }
  }
  if (
    identityVerified &&
    (inCall || join) &&
    !allowMicrophone &&
    microphoneState !== "off" &&
    !controlManualActionReason
  ) {
    controlManualActionReason = "zoom-microphone-required";
    controlManualActionMessage = inCall
      ? "Mute the Zoom microphone and verify it stays muted for observe-only mode."
      : "Mute the Zoom microphone and verify the microphone control shows it is off, then retry joining.";
  }`,
    manualActionSource: `  const signInControl = first(selectors.signIn);
  const tenantLoginRequired =
    /authorized attendees only|meeting is for authorized attendees|sign in to join|verify your email|enter the code sent to/i.test(pageTextLower);
  const loginRequired = tenantLoginRequired ||
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
  // Zoom shows the same no-audio/video warning when only camera access is denied.
  // A granted microphone plus the verified BlackHole input is sufficient for talk-back.
  const permissionRequired = devicePermissionPrompt &&
    (!allowMicrophone || microphonePermissionState !== "granted");
  let manualActionReason;
  let manualActionMessage;
  if (committedOwnerConflict && !canMutateSession) {
    manualActionReason = "zoom-session-conflict";
    manualActionMessage = "This Zoom tab is owned by another active meeting session.";
  } else if (!inCall && loginRequired) {
    manualActionReason = "zoom-login-required";
    manualActionMessage = tenantLoginRequired
      ? "This Zoom tenant requires sign-in or email verification. Complete it in the OpenClaw browser profile, then retry."
      : "Sign in to Zoom in the OpenClaw browser profile, then retry the meeting join.";
  } else if (!inCall && lobbyWaiting) {
    manualActionReason = "zoom-admission-required";
    manualActionMessage = "Admit the OpenClaw guest from the Zoom lobby, then retry speech.";
  } else if (!inCall && permissionRequired) {
    manualActionReason = "zoom-permission-required";
    manualActionMessage = allowMicrophone
      ? "Allow microphone permission for Zoom in the OpenClaw browser profile, then retry."
      : "Dismiss the Zoom device-permission prompt or continue without devices, then retry.";
  } else if (controlManualActionReason) {
    manualActionReason = controlManualActionReason;
    manualActionMessage = controlManualActionMessage;
  }
  let clickedJoin = false;
  if (canMutateSession && identityVerified && autoJoin && !inCall && join && !join.disabled && !manualActionReason) {
    join.click();
    clickedJoin = true;
    notes.push("Clicked the Zoom guest join button.");
  }`,
    platform: {
      displayName: "Zoom",
      globals: {
        audioOutputs: "__openclawZoomAudioOutputs",
        captionArchive: "__openclawZoomCaptionArchive",
        captions: "__openclawZoomCaptions",
        meeting: "__openclawZoomMeeting",
      },
      manualActionReasonPrefix: "zoom",
    },
    setupSource: `const topDocument = globalThis.document;
  const document = topDocument.querySelector("#webclient")?.contentDocument || topDocument;
  const pageWindow = document.defaultView || globalThis;
  const HTMLInputElement = pageWindow.HTMLInputElement || globalThis.HTMLInputElement;
  const Event = pageWindow.Event || globalThis.Event;
  const MutationObserver = pageWindow.MutationObserver || globalThis.MutationObserver;`,
  });
}
