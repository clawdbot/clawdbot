// Google Meet owns its DOM selectors and in-page automation scripts.
import { normalizeMeetUrlForReuse } from "./google-meet-urls.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES } from "./types.js";

const GOOGLE_MEET_CAPTION_SETTLE_MS = 1_000;

export function meetStatusScript(params: {
  allowMicrophone: boolean;
  autoJoin: boolean;
  captionSessionId?: string;
  captureCaptions: boolean;
  guestName: string;
  readOnly?: boolean;
}) {
  return `async () => {
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const manualActionFor = (reason, message) => ({ reason, message });
  const allowMicrophone = ${JSON.stringify(params.allowMicrophone)};
  const captionSessionId = ${JSON.stringify(params.captionSessionId)};
  const captureCaptions = ${JSON.stringify(params.captureCaptions)};
  const readOnly = ${JSON.stringify(Boolean(params.readOnly))};
  const buttons = () => [...document.querySelectorAll('button')];
  const buttonLabel = (button) =>
    [
      button.getAttribute("aria-label"),
      button.getAttribute("data-tooltip"),
      text(button),
    ]
      .filter(Boolean)
      .join(" ");
  const buttonLabels = buttons().map(buttonLabel).filter(Boolean);
  const notes = [];
  let audioInputRouted;
  let audioInputDeviceLabel;
  let audioInputRouteError;
  let audioOutputRouted;
  let audioOutputDeviceLabel;
  let audioOutputRouteError;
  const findButton = (pattern) =>
    buttons().find((button) => {
      const label = buttonLabel(button);
      return pattern.test(label) && !button.disabled;
    });
  const findCallControlButton = (pattern) =>
    buttons().find((button) => {
      const label = buttonLabel(button);
      return pattern.test(label) && !/remotely mute|someone else/i.test(label) && !button.disabled;
    });
  const audioDeviceFamily = (value) => {
    const label = String(value || '');
    if (/\\bOpenClaw Meeting Audio\\b/i.test(label)) return 'openclaw-meeting-audio';
    if (/\\bBlackHole\\s+2ch\\b/i.test(label)) return 'blackhole-2ch';
    return undefined;
  };
  const isMeetingAudioDevice = (value) => Boolean(audioDeviceFamily(value));
  const deviceNodeLabel = (node) => [
    node?.getAttribute?.('aria-label'),
    node?.getAttribute?.('data-tooltip'),
    node?.getAttribute?.('title'),
    node?.label,
    node?.textContent,
    node?.innerText,
  ].filter(Boolean).join(' ').trim();
  const waitForUi = () => new Promise((resolve) => setTimeout(resolve, 100));
  const input = [...document.querySelectorAll('input')].find((el) =>
    /your name/i.test(el.getAttribute('aria-label') || el.placeholder || '')
  );
  if (!readOnly && ${JSON.stringify(params.autoJoin)} && input && !input.value) {
    input.focus();
    input.value = ${JSON.stringify(params.guestName)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const pageText = text(document.body).toLowerCase();
  const permissionText = [pageText, ...buttonLabels].join("\\n");
  const host = location.hostname.toLowerCase();
  const pageUrl = location.href;
  const permissionNeeded = /permission needed|microphone problem|speaker problem|allow.*(microphone|camera)|blocked.*(microphone|camera)|permission.*(microphone|camera|speaker)/i.test(permissionText);
  let mic = findCallControlButton(/^\\s*turn (?:off|on) microphone\\b/i);
  if (!mic) {
    const callControls = document.querySelector('[role="region"][aria-label="Call controls"]');
    mic = [...(callControls?.querySelectorAll('button') || [])].find((button) =>
      /^\\s*turn (?:off|on) microphone\\b/i.test(buttonLabel(button))
    );
  }
  const joinElsewhere = findButton(/join here too/i);
  const microphoneChoice = findButton(/\\buse microphone\\b/i);
  const noMicrophoneChoice = findButton(/\\b(continue|join|use) without (microphone|mic)\\b|\\bnot now\\b/i);
  if (!readOnly && allowMicrophone && microphoneChoice) {
    microphoneChoice.click();
    notes.push("Accepted Meet microphone prompt with browser automation.");
    await waitForUi();
  } else if (!readOnly && !allowMicrophone && noMicrophoneChoice) {
    noMicrophoneChoice.click();
    notes.push("Skipped Meet microphone prompt for observe-only mode.");
    await waitForUi();
  }
  const findMicrophoneDeviceControl = () => {
    const selectors = [
      'select[aria-label*="microphone" i]',
      'select[name*="microphone" i]',
      '[role="combobox"][aria-label*="microphone" i]',
      '[role="listbox"][aria-label*="microphone" i]',
      '[aria-haspopup="listbox"][aria-label*="microphone" i]',
    ];
    for (const selector of selectors) {
      const control = document.querySelector(selector);
      if (control) return control;
    }
    return undefined;
  };
  const selectedMicrophoneLabel = () => {
    const control = findMicrophoneDeviceControl();
    const nativeSelected = control?.selectedOptions?.[0];
    if (nativeSelected && isMeetingAudioDevice(deviceNodeLabel(nativeSelected))) {
      return deviceNodeLabel(nativeSelected);
    }
    const controlledId = control?.getAttribute?.('aria-controls');
    const optionsRoot = controlledId ? document.getElementById?.(controlledId) : control;
    const selected = [...(optionsRoot?.querySelectorAll?.(
      '[role="option"][aria-selected="true"], [role="menuitemradio"][aria-checked="true"], [role="radio"][aria-checked="true"]'
    ) || [])].find((node) => isMeetingAudioDevice(deviceNodeLabel(node)));
    if (selected) return deviceNodeLabel(selected);
    const role = control?.getAttribute?.('role');
    if (
      !control?.options &&
      role !== 'listbox' &&
      control &&
      isMeetingAudioDevice(deviceNodeLabel(control))
    ) {
      return deviceNodeLabel(control);
    }
    return undefined;
  };
  const openMicrophoneDeviceSettings = async () => {
    if (findMicrophoneDeviceControl()) return;
    const candidates = () => [
      ...document.querySelectorAll('button, [role="menuitem"], [role="tab"]'),
    ];
    const direct = candidates().find((node) =>
      /\\b(?:audio|microphone|device) settings\\b/i.test(deviceNodeLabel(node)) && !node.disabled
    );
    let settings = direct || candidates().find((node) =>
      /^\\s*settings\\s*$/i.test(deviceNodeLabel(node)) && !node.disabled
    );
    if (!settings && !readOnly) {
      const moreOptions = candidates().find((node) =>
        /^\\s*more options\\s*$/i.test(deviceNodeLabel(node)) && !node.disabled
      );
      if (moreOptions) {
        moreOptions.click();
        await waitForUi();
        settings = candidates().find((node) =>
          /^\\s*settings\\s*$/i.test(deviceNodeLabel(node)) && !node.disabled
        );
      }
    }
    if (!settings || readOnly) return;
    settings.click();
    await waitForUi();
    const audioTab = [...document.querySelectorAll('button, [role="tab"]')].find((node) =>
      /^\\s*audio\\s*$/i.test(deviceNodeLabel(node)) && !node.disabled
    );
    if (audioTab) {
      audioTab.click();
      await waitForUi();
    }
  };
  const routeMeetAudioInput = async () => {
    if (
      !allowMicrophone ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.enumerateDevices
    ) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const input = devices.find((device) =>
        device.kind === 'audioinput' && isMeetingAudioDevice(device.label)
      );
      if (!input?.deviceId) {
        audioInputRouted = false;
        audioInputRouteError = 'A supported virtual microphone was not visible to Meet.';
        return;
      }
      audioInputDeviceLabel = input.label || 'OpenClaw meeting audio';
      const inputFamily = audioDeviceFamily(audioInputDeviceLabel);
      if (audioDeviceFamily(selectedMicrophoneLabel()) === inputFamily) {
        audioInputRouted = true;
        return;
      }
      if (readOnly) {
        audioInputRouted = false;
        return;
      }
      await openMicrophoneDeviceSettings();
      const control = findMicrophoneDeviceControl();
      if (!control) {
        audioInputRouted = false;
        audioInputRouteError = 'Meet microphone device selector was not available.';
        return;
      }
      const nativeOptions = [...(control.options || [])];
      const nativeOption = nativeOptions.find(
        (option) => audioDeviceFamily(deviceNodeLabel(option)) === inputFamily
      );
      if (nativeOption) {
        control.value = nativeOption.value;
        nativeOption.selected = true;
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        control.click?.();
        await waitForUi();
        const choices = [...document.querySelectorAll(
          '[role="option"], [role="menuitemradio"], [role="radio"]'
        )];
        const choice = choices.find(
          (node) => audioDeviceFamily(deviceNodeLabel(node)) === inputFamily && !node.disabled
        );
        choice?.click?.();
      }
      await waitForUi();
      audioInputRouted = audioDeviceFamily(selectedMicrophoneLabel()) === inputFamily;
      if (audioInputRouted) {
        notes.push(\`Selected \${audioInputDeviceLabel} as the Meet microphone.\`);
      } else {
        audioInputRouteError = \`Meet did not confirm \${audioInputDeviceLabel} as its microphone.\`;
      }
    } catch (error) {
      audioInputRouted = false;
      audioInputRouteError = error?.message || String(error);
      notes.push(\`Could not select the Meet virtual microphone: \${audioInputRouteError}\`);
    }
  };
  await routeMeetAudioInput();
  mic = findCallControlButton(/^\\s*turn (?:off|on) microphone\\b/i) || mic;
  if (
    !readOnly &&
    allowMicrophone &&
    audioInputRouted !== true &&
    mic &&
    /turn off microphone/i.test(buttonLabel(mic))
  ) {
    mic.click();
    notes.push("Muted the Meet microphone because the virtual audio input was not verified.");
    mic = findCallControlButton(/^\\s*turn (?:off|on) microphone\\b/i) || mic;
  }
  if (!readOnly && allowMicrophone && audioInputRouted === true && mic && /turn on microphone/i.test(buttonLabel(mic))) {
    mic.click();
    notes.push("Turned on the Meet microphone after verifying the virtual audio input.");
  }
  if (!readOnly && !allowMicrophone && mic && /turn off microphone/i.test(mic.getAttribute('aria-label') || text(mic))) {
    mic.click();
    notes.push("Muted Meet microphone for observe-only mode.");
  }
  const join = !readOnly && ${JSON.stringify(params.autoJoin)}
    ? findButton(/join now|ask to join/i)
    : null;
  if (join) join.click();
  const inCall = buttons().some((button) => /leave call/i.test(button.getAttribute('aria-label') || text(button)));
  const routeMeetAudioOutput = async () => {
    if (
      !allowMicrophone ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.enumerateDevices
    ) return;
    const mediaElements = [...document.querySelectorAll('audio, video')]
      .filter((el) => typeof el.setSinkId === 'function');
    if (mediaElements.length === 0) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputFamily = audioDeviceFamily(audioInputDeviceLabel);
      const output = devices.find((device) =>
        device.kind === 'audiooutput' &&
        inputFamily &&
        audioDeviceFamily(device.label) === inputFamily
      ) || devices.find((device) =>
        device.kind === 'audiooutput' && isMeetingAudioDevice(device.label)
      );
      if (!output?.deviceId) {
        audioOutputRouted = false;
        if (devices.some((device) => device.kind === 'audiooutput')) {
          notes.push("A supported virtual speaker output was not visible to Meet.");
        }
        return;
      }
      let routed = 0;
      for (const element of mediaElements) {
        if (element.sinkId !== output.deviceId) {
          if (readOnly) {
            continue;
          }
          await element.setSinkId(output.deviceId);
          routed += 1;
        }
      }
      audioOutputRouted = mediaElements.some((element) => element.sinkId === output.deviceId);
      audioOutputDeviceLabel = output.label || "OpenClaw meeting audio";
      if (!readOnly && audioOutputRouted) {
        notes.push(
          routed > 0
            ? \`Routed Meet media output to \${audioOutputDeviceLabel}.\`
            : \`Meet media output already routed to \${audioOutputDeviceLabel}.\`
        );
      }
    } catch (error) {
      audioOutputRouted = false;
      audioOutputRouteError = error?.message || String(error);
      notes.push(\`Could not route Meet speaker output to the virtual audio device: \${audioOutputRouteError}\`);
    }
  };
  if (inCall) {
    await routeMeetAudioOutput();
  }
  let captioning = false;
  let captionsEnabledAttempted = false;
  let transcriptLines = 0;
  let lastCaptionAt;
  let lastCaptionSpeaker;
  let lastCaptionText;
  let recentTranscript = [];
  const captionSelector = '[role="region"][aria-label*="aption" i], [aria-live="polite"][role="region"], div[aria-live="polite"]';
  const captionState = (() => {
    if (!captureCaptions) return undefined;
    const w = window;
    if (!inCall && !w.__openclawMeetCaptions) return undefined;
    // A reused tab starts a fresh logical transcript for each OpenClaw session.
    // Status refreshes omit the id, so they preserve the active page-owned buffer.
    if (!w.__openclawMeetCaptions || (captionSessionId && w.__openclawMeetCaptions.sessionId !== captionSessionId)) {
      if (w.__openclawMeetCaptions?.settleTimer !== undefined) {
        clearTimeout(w.__openclawMeetCaptions.settleTimer);
      }
      w.__openclawMeetCaptions?.observer?.disconnect?.();
      w.__openclawMeetCaptions = {
        sessionId: captionSessionId,
        // Epochs cross document lifetimes in the runtime transcript cursor.
        // Strong UUIDs keep a reloaded page distinct from its prior buffer.
        epoch: crypto.randomUUID(),
        enabledAttempted: false,
        observerInstalled: false,
        observer: undefined,
        droppedLines: 0,
        lines: [],
        settleTimer: undefined,
        visible: []
      };
    }
    return w.__openclawMeetCaptions;
  })();
  const normalizeCaption = (speaker, captionText) => {
    if (!captionState) return;
    const clean = String(captionText || "").replace(/\\s+/g, " ").trim();
    const cleanSpeaker = String(speaker || "").replace(/\\s+/g, " ").trim();
    if (!clean || clean.length < 2) return undefined;
    if (/^(turn on captions|turn off captions|captions)$/i.test(clean)) return undefined;
    return { speaker: cleanSpeaker || undefined, text: clean };
  };
  const commitLines = (state, entries) => {
    state.lines.push(...entries.map((entry) => ({
      at: entry.at,
      speaker: entry.speaker,
      text: entry.text
    })));
    const excess = state.lines.length - ${GOOGLE_MEET_TRANSCRIPT_MAX_LINES};
    if (excess > 0) {
      state.lines.splice(0, excess);
      state.droppedLines = (state.droppedLines || 0) + excess;
    }
  };
  const scrapeCaptions = () => {
    if (!captionState) return;
    const regions = [...document.querySelectorAll(captionSelector)];
    const rows = [];
    for (const region of regions) {
      const raw = text(region);
      if (!raw) continue;
      const pieces = raw.split(/\\n+/).map((part) => part.trim()).filter(Boolean);
      const row = pieces.length >= 2
        ? normalizeCaption(pieces[0], pieces.slice(1).join(" "))
        : normalizeCaption("", pieces[0] || raw);
      if (row) rows.push({ ...row, node: region });
    }
    if (rows.length === 0) {
      // Meet briefly removes caption rows while rerendering. Keep them mutable
      // for one settle window so a DOM gap cannot fabricate a repeated line.
      if (captionState.visible.length > 0 && captionState.settleTimer === undefined) {
        const pendingState = captionState;
        pendingState.settleTimer = setTimeout(() => {
          if (window.__openclawMeetCaptions !== pendingState) return;
          commitLines(pendingState, pendingState.visible);
          pendingState.visible = [];
          pendingState.settleTimer = undefined;
        }, ${GOOGLE_MEET_CAPTION_SETTLE_MS});
      }
      return;
    }
    if (captionState.settleTimer !== undefined) {
      clearTimeout(captionState.settleTimer);
      captionState.settleTimer = undefined;
    }
    const previous = Array.isArray(captionState.visible) ? captionState.visible : [];
    const unmatchedPrevious = [...previous];
    const nextVisible = [];
    const now = Date.now();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const priorIndex = unmatchedPrevious.findIndex((candidate) => {
        const sameTextLifecycle =
          candidate.text === row.text ||
          row.text.startsWith(candidate.text) ||
          candidate.text.startsWith(row.text);
        const sameDomLifecycle =
          candidate.node === row.node || now - candidate.seenAt <= ${GOOGLE_MEET_CAPTION_SETTLE_MS};
        return candidate.speaker === row.speaker && sameTextLifecycle && sameDomLifecycle;
      });
      const prior = priorIndex >= 0 ? unmatchedPrevious.splice(priorIndex, 1)[0] : undefined;
      const sameSpeaker = Boolean(prior) && prior.speaker === row.speaker;
      if (sameSpeaker && prior.text === row.text) {
        prior.node = row.node;
        prior.seenAt = now;
        nextVisible.push(prior);
        continue;
      }
      if (sameSpeaker && row.text.startsWith(prior.text)) {
        prior.text = row.text;
        prior.node = row.node;
        prior.seenAt = now;
        nextVisible.push(prior);
        continue;
      }
      if (sameSpeaker && prior.text.startsWith(row.text)) {
        prior.node = row.node;
        prior.seenAt = now;
        nextVisible.push(prior);
        continue;
      }
      const entry = {
        at: new Date().toISOString(),
        node: row.node,
        seenAt: now,
        speaker: row.speaker,
        text: row.text
      };
      nextVisible.push(entry);
    }
    commitLines(captionState, unmatchedPrevious);
    captionState.visible = nextVisible;
  };
  if (captionState) {
    if (!readOnly && inCall && !captionState.enabledAttempted) {
      const captionButton = findButton(/turn on captions|show captions|captions/i);
      const captionLabel = captionButton ? (captionButton.getAttribute("aria-label") || captionButton.getAttribute("data-tooltip") || text(captionButton)) : "";
      if (captionButton) {
        captionState.enabledAttempted = true;
        captionsEnabledAttempted = true;
        if (!/turn off captions|hide captions/i.test(captionLabel)) {
          captionButton.click();
          notes.push("Attempted to enable Meet captions for observe-only transcript health.");
        }
      }
    } else if (captionState.enabledAttempted) {
      captionsEnabledAttempted = true;
    }
    if (inCall && !captionState.observerInstalled) {
      captionState.observerInstalled = true;
      captionState.observer = new MutationObserver(scrapeCaptions);
      captionState.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
      notes.push("Installed Meet caption observer for observe-only transcript health.");
    }
    if (inCall) {
      scrapeCaptions();
    }
    const committedLines = Array.isArray(captionState.lines) ? captionState.lines : [];
    const visibleLines = Array.isArray(captionState.visible) ? captionState.visible : [];
    const lines = [...committedLines, ...visibleLines];
    const last = lines[lines.length - 1];
    captioning = document.querySelector(captionSelector) !== null || lines.length > 0;
    transcriptLines = (captionState.droppedLines || 0) + lines.length;
    lastCaptionAt = last?.at;
    lastCaptionSpeaker = last?.speaker;
    lastCaptionText = last?.text;
    recentTranscript = lines.slice(-5);
  }
  const lobbyWaiting = !inCall && /asking to be let in|you.?ll join when someone lets you in|waiting to be let in|ask to join/i.test(pageText);
  const leaveReason = !inCall && /you left the meeting|you.?ve left the meeting|removed from the meeting|you were removed|call ended|meeting ended/i.test(pageText)
    ? pageText.match(/you left the meeting|you.?ve left the meeting|removed from the meeting|you were removed|call ended|meeting ended/i)?.[0]
    : undefined;
  let manualAction;
  if (!inCall && (host === "accounts.google.com" || /use your google account|to continue to google meet|choose an account|sign in to (join|continue)/i.test(pageText))) {
    manualAction = manualActionFor("google-login-required", "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.");
  } else if (!inCall && joinElsewhere) {
    manualAction = manualActionFor("meet-session-conflict", "Meet is already active in another tab or device. Leave that session or reuse an English-pinned tab before retrying.");
  } else if (!inCall && /asking to be let in|you.?ll join when someone lets you in|waiting to be let in|ask to join/i.test(pageText)) {
    manualAction = manualActionFor("meet-admission-required", "Admit the OpenClaw browser participant in Google Meet, then retry speech.");
  } else if (permissionNeeded) {
    manualAction = manualActionFor("meet-permission-required", allowMicrophone ? "Allow microphone/camera/speaker permissions for Meet in the OpenClaw browser profile, then retry." : "Join without microphone/camera permissions in the OpenClaw browser profile, then retry.");
  } else if (inCall && allowMicrophone && (audioInputRouted !== true || audioOutputRouted !== true)) {
    manualAction = manualActionFor(
      "meet-audio-choice-required",
      "Select BlackHole 2ch or OpenClaw Meeting Audio as both the Meet microphone and speaker, then retry."
    );
  } else if (!inCall && (allowMicrophone ? !microphoneChoice : !noMicrophoneChoice) && /do you want people to hear you in the meeting/i.test(pageText)) {
    manualAction = manualActionFor("meet-audio-choice-required", allowMicrophone ? "Meet is showing the microphone choice. Click Use microphone in the OpenClaw browser profile, then retry." : "Meet is showing the microphone choice. Choose the no-microphone option in the OpenClaw browser profile, then retry.");
  }
  return JSON.stringify({
    clickedJoin: Boolean(join),
    clickedMicrophoneChoice: Boolean(allowMicrophone && microphoneChoice),
    inCall,
    micMuted: mic ? /turn on microphone/i.test(buttonLabel(mic)) : undefined,
    lobbyWaiting,
    leaveReason,
    captioning,
    captionsEnabledAttempted,
    transcriptLines,
    lastCaptionAt,
    lastCaptionSpeaker,
    lastCaptionText,
    recentTranscript,
    audioInputRouted,
    audioInputDeviceLabel,
    audioInputRouteError,
    audioOutputRouted,
    audioOutputDeviceLabel,
    audioOutputRouteError,
    manualAction,
    title: document.title,
    url: pageUrl,
    notes
  });
}`;
}

export function meetTranscriptScript(
  meetingUrl: string,
  meetingSessionId: string,
  finalize: boolean,
) {
  const expectedMeetingUrl = normalizeMeetUrlForReuse(meetingUrl);
  return `() => {
  const expectedMeetingUrl = ${JSON.stringify(expectedMeetingUrl)};
  const expectedSessionId = ${JSON.stringify(meetingSessionId)};
  let currentMeetingUrl;
  try {
    const currentUrl = new URL(location.href);
    currentMeetingUrl = currentUrl.origin + currentUrl.pathname.toLowerCase().replace(/\\/$/, "");
  } catch {
    return JSON.stringify({ urlMatched: false });
  }
  if (!expectedMeetingUrl || currentMeetingUrl !== expectedMeetingUrl) {
    return JSON.stringify({ urlMatched: false });
  }
  const state = window.__openclawMeetCaptions;
  if (state?.sessionId && state.sessionId !== expectedSessionId) {
    return JSON.stringify({ urlMatched: true, sessionMatched: false });
  }
  if (${JSON.stringify(finalize)} && Array.isArray(state?.visible) && state.visible.length > 0) {
    if (state.settleTimer !== undefined) clearTimeout(state.settleTimer);
    state.settleTimer = undefined;
    state.lines = Array.isArray(state.lines) ? state.lines : [];
    state.lines.push(...state.visible.map((entry) => ({
      at: entry.at,
      speaker: entry.speaker,
      text: entry.text
    })));
    state.visible = [];
    const excess = state.lines.length - ${GOOGLE_MEET_TRANSCRIPT_MAX_LINES};
    if (excess > 0) {
      state.lines.splice(0, excess);
      state.droppedLines = (state.droppedLines || 0) + excess;
    }
  }
  const lines = Array.isArray(state?.lines) ? state.lines : [];
  return JSON.stringify({
    urlMatched: true,
    sessionMatched: true,
    epoch: typeof state?.epoch === "string" ? state.epoch : undefined,
    droppedLines: Number.isFinite(state?.droppedLines) ? Math.max(0, Math.trunc(state.droppedLines)) : 0,
    lines: lines.map((line) => ({
      at: typeof line?.at === "string" ? line.at : undefined,
      speaker: typeof line?.speaker === "string" ? line.speaker : undefined,
      text: typeof line?.text === "string" ? line.text : ""
    })).filter((line) => line.text)
  });
}`;
}

export function meetLeaveScript(meetingUrl: string) {
  const expectedMeetingUrl = normalizeMeetUrlForReuse(meetingUrl);
  return `() => {
  const expectedMeetingUrl = ${JSON.stringify(expectedMeetingUrl)};
  let currentMeetingUrl;
  try {
    const currentUrl = new URL(location.href);
    currentMeetingUrl = currentUrl.origin + currentUrl.pathname.toLowerCase().replace(/\\/$/, "");
  } catch {
    return JSON.stringify({ departed: false });
  }
  if (!expectedMeetingUrl) {
    return JSON.stringify({ departed: false });
  }
  if (currentMeetingUrl !== expectedMeetingUrl) {
    return JSON.stringify({ departed: true, urlMatched: false });
  }
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  // Locale-independent fallback: Meet renders the leave control as a Material
  // Symbols icon whose ligature text is "call_end" in every UI language, so a
  // localized aria-label (e.g. "Anruf verlassen") still resolves to the button.
  const hasLeaveIcon = (button) => {
    const icon = button.querySelector ? button.querySelector("i") : null;
    return icon ? (icon.textContent || "").trim() === "call_end" : false;
  };
  const buttons = [...document.querySelectorAll('button')];
  const label = (button) => [
    button.getAttribute("aria-label"),
    button.getAttribute("data-tooltip"),
    text(button),
  ]
    .filter(Boolean)
    .join(" ");
  const postCall = buttons.some((button) => /\\b(rejoin|return to home screen)\\b/i.test(label(button)));
  if (postCall) {
    return JSON.stringify({ departed: true, urlMatched: true });
  }
  // Managed join tabs are reused only after the English-tab gate or opened
  // through the English-UI helper, so follow-up labels are pinned to English.
  const confirmation = buttons.find((button) => {
    return !button.disabled && /\\bleave meeting\\b/i.test(label(button));
  });
  if (confirmation) {
    confirmation.click();
    return JSON.stringify({ departed: false, leaveAction: "confirm", urlMatched: true });
  }
  const leave = buttons.find((button) => {
    if (button.disabled) return false;
    return /leave call/i.test(label(button)) || hasLeaveIcon(button);
  });
  if (leave) {
    leave.click();
    return JSON.stringify({ departed: false, leaveAction: "leave", urlMatched: true });
  }
  return JSON.stringify({ departed: false, urlMatched: true });
}`;
}
