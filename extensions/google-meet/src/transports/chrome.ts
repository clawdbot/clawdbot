// Google Meet plugin module implements chrome behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GoogleMeetConfig, GoogleMeetMode } from "../config.js";
import {
  startNodeAgentAudioBridge,
  startNodeRealtimeAudioBridge,
  type ChromeNodeRealtimeAudioBridgeHandle,
} from "../realtime-node.js";
import {
  startCommandAgentAudioBridge,
  startCommandRealtimeAudioBridge,
  type ChromeRealtimeAudioBridgeHandle,
} from "../realtime.js";
import {
  GOOGLE_MEET_SYSTEM_PROFILER_COMMAND,
  outputMentionsBlackHole2ch,
} from "./chrome-audio-device.js";
import {
  asBrowserTabs,
  callBrowserProxyOnNode,
  forceMeetEnglishUi,
  isEnglishMeetTab,
  isSameMeetUrlForReuse,
  normalizeMeetUrlForReuse,
  readBrowserTab,
  resolveChromeNode,
  type BrowserTab,
} from "./chrome-browser-proxy.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES } from "./types.js";
import type {
  GoogleMeetBrowserTab,
  GoogleMeetChromeHealth,
  GoogleMeetTranscriptSnapshot,
} from "./types.js";

type BrowserRequestParams = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
};

type BrowserRequestCaller = (params: BrowserRequestParams) => Promise<unknown>;

const GOOGLE_MEET_CAPTION_SETTLE_MS = 1_000;

function isGoogleMeetTalkBackMode(mode: GoogleMeetMode): boolean {
  return mode === "agent" || mode === "bidi";
}

function readMeetAuthUser(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).searchParams.get("authuser") ?? undefined;
  } catch {
    return undefined;
  }
}

export async function assertBlackHole2chAvailable(params: {
  runtime: PluginRuntime;
  timeoutMs: number;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Chrome Meet transport with blackhole-2ch audio is currently macOS-only");
  }

  const result = await params.runtime.system.runCommandWithTimeout(
    [GOOGLE_MEET_SYSTEM_PROFILER_COMMAND, "SPAudioDataType"],
    { timeoutMs: params.timeoutMs },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.code !== 0 || !outputMentionsBlackHole2ch(output)) {
    const hint =
      params.runtime.system.formatNativeDependencyHint?.({
        packageName: "BlackHole 2ch",
        downloadCommand: "brew install blackhole-2ch",
      }) ?? "";
    throw new Error(
      [
        "BlackHole 2ch audio device not found.",
        "Install BlackHole 2ch and route Chrome input/output through the OpenClaw audio bridge.",
        hint,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

export async function launchChromeMeet(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  requesterSessionKey?: string;
  mode: GoogleMeetMode;
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle);
  browser?: GoogleMeetChromeHealth;
  tab?: GoogleMeetBrowserTab;
}> {
  const checkRealtimeAudioPrerequisites = async () => {
    if (!isGoogleMeetTalkBackMode(params.mode)) {
      return;
    }
    await assertBlackHole2chAvailable({
      runtime: params.runtime,
      timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
    });

    if (params.config.chrome.audioBridgeHealthCommand) {
      const health = await params.runtime.system.runCommandWithTimeout(
        params.config.chrome.audioBridgeHealthCommand,
        { timeoutMs: params.config.chrome.joinTimeoutMs },
      );
      if (health.code !== 0) {
        throw new Error(
          `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
        );
      }
    }
  };

  const startRealtimeAudioBridge = async (): Promise<
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle)
    | undefined
  > => {
    if (!isGoogleMeetTalkBackMode(params.mode)) {
      return undefined;
    }
    if (params.config.chrome.audioBridgeCommand) {
      if (params.mode === "agent") {
        throw new Error(
          "Chrome agent mode requires chrome.audioInputCommand and chrome.audioOutputCommand so OpenClaw can run STT and regular TTS directly.",
        );
      }
      const bridge = await params.runtime.system.runCommandWithTimeout(
        params.config.chrome.audioBridgeCommand,
        { timeoutMs: params.config.chrome.joinTimeoutMs },
      );
      if (bridge.code !== 0) {
        throw new Error(
          `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
        );
      }
      return { type: "external-command" };
    }
    if (!params.config.chrome.audioInputCommand || !params.config.chrome.audioOutputCommand) {
      throw new Error(
        "Chrome talk-back mode requires chrome.audioInputCommand and chrome.audioOutputCommand, or chrome.audioBridgeCommand for an external bridge.",
      );
    }
    return {
      type: "command-pair",
      ...(params.mode === "agent"
        ? await startCommandAgentAudioBridge({
            config: params.config,
            fullConfig: params.fullConfig,
            runtime: params.runtime,
            meetingSessionId: params.meetingSessionId,
            requesterSessionKey: params.requesterSessionKey,
            inputCommand: params.config.chrome.audioInputCommand,
            outputCommand: params.config.chrome.audioOutputCommand,
            logger: params.logger,
          })
        : await startCommandRealtimeAudioBridge({
            config: {
              ...params.config,
              realtime: { ...params.config.realtime, strategy: "bidi" },
            },
            fullConfig: params.fullConfig,
            runtime: params.runtime,
            meetingSessionId: params.meetingSessionId,
            requesterSessionKey: params.requesterSessionKey,
            inputCommand: params.config.chrome.audioInputCommand,
            outputCommand: params.config.chrome.audioOutputCommand,
            logger: params.logger,
          })),
    };
  };

  await checkRealtimeAudioPrerequisites();

  if (!params.config.chrome.launch) {
    return { launched: false, audioBridge: await startRealtimeAudioBridge() };
  }

  const result = await openMeetWithBrowserRequest({
    callBrowser: await resolveLocalBrowserRequest(params.runtime),
    config: params.config,
    mode: params.mode,
    meetingSessionId: params.meetingSessionId,
    url: params.url,
  });
  const shouldStartRealtimeBridge =
    isGoogleMeetTalkBackMode(params.mode) &&
    result.browser?.inCall === true &&
    result.browser.micMuted !== true &&
    result.browser.manualActionRequired !== true;
  const audioBridge = shouldStartRealtimeBridge ? await startRealtimeAudioBridge() : undefined;
  return { ...result, audioBridge };
}

function parseNodeStartResult(raw: unknown): {
  launched?: boolean;
  bridgeId?: string;
  audioBridge?: { type?: string };
  browser?: GoogleMeetChromeHealth;
} {
  const value =
    raw && typeof raw === "object" && "payload" in raw
      ? (raw as { payload?: unknown }).payload
      : raw;
  if (!value || typeof value !== "object") {
    throw new Error("Google Meet node returned an invalid start result.");
  }
  return value as {
    launched?: boolean;
    bridgeId?: string;
    audioBridge?: { type?: string };
    browser?: GoogleMeetChromeHealth;
  };
}

function parseMeetBrowserStatus(result: unknown): GoogleMeetChromeHealth | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const raw = record.result;
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  let parsed: {
    inCall?: boolean;
    micMuted?: boolean;
    lobbyWaiting?: boolean;
    leaveReason?: string;
    captioning?: boolean;
    captionsEnabledAttempted?: boolean;
    transcriptLines?: number;
    lastCaptionAt?: string;
    lastCaptionSpeaker?: string;
    lastCaptionText?: string;
    recentTranscript?: GoogleMeetChromeHealth["recentTranscript"];
    audioOutputRouted?: boolean;
    audioOutputDeviceLabel?: string;
    audioOutputRouteError?: string;
    manualActionRequired?: boolean;
    manualActionReason?: GoogleMeetChromeHealth["manualActionReason"];
    manualActionMessage?: string;
    url?: string;
    title?: string;
    notes?: string[];
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error("Google Meet browser status JSON is malformed.");
  }
  return {
    inCall: parsed.inCall,
    micMuted: parsed.micMuted,
    lobbyWaiting: parsed.lobbyWaiting,
    leaveReason: parsed.leaveReason,
    captioning: parsed.captioning,
    captionsEnabledAttempted: parsed.captionsEnabledAttempted,
    transcriptLines: parsed.transcriptLines,
    lastCaptionAt: parsed.lastCaptionAt,
    lastCaptionSpeaker: parsed.lastCaptionSpeaker,
    lastCaptionText: parsed.lastCaptionText,
    recentTranscript: parsed.recentTranscript,
    audioOutputRouted: parsed.audioOutputRouted,
    audioOutputDeviceLabel: parsed.audioOutputDeviceLabel,
    audioOutputRouteError: parsed.audioOutputRouteError,
    manualActionRequired: parsed.manualActionRequired,
    manualActionReason: parsed.manualActionReason,
    manualActionMessage: parsed.manualActionMessage,
    browserUrl: parsed.url,
    browserTitle: parsed.title,
    status: "browser-control",
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.filter((note): note is string => typeof note === "string")
      : undefined,
  };
}

async function callLocalBrowserRequest(params: BrowserRequestParams) {
  return await callGatewayFromCli(
    "browser.request",
    {
      json: true,
      timeout: String(resolveBrowserGatewayTimeoutMs(params.timeoutMs)),
    },
    {
      method: params.method,
      path: params.path,
      body: params.body,
      timeoutMs: params.timeoutMs,
    },
    { progress: false },
  );
}

async function resolveLocalBrowserRequest(runtime: PluginRuntime): Promise<BrowserRequestCaller> {
  // Gateway-hosted plugin work stays in-process; otherwise agent tools would
  // need an external operator.admin token just to reach the local browser.
  if (!(await runtime.gateway.isAvailable())) {
    return callLocalBrowserRequest;
  }
  return async (params) =>
    await runtime.gateway.request(
      "browser.request",
      {
        method: params.method,
        path: params.path,
        body: params.body,
        timeoutMs: params.timeoutMs,
      },
      {
        timeoutMs: resolveBrowserGatewayTimeoutMs(params.timeoutMs),
        scopes: ["operator.admin"],
      },
    );
}

function resolveBrowserGatewayTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs) ?? 1;
}

function mergeBrowserNotes(
  browser: GoogleMeetChromeHealth | undefined,
  notes: string[],
): GoogleMeetChromeHealth | undefined {
  if (!browser || notes.length === 0) {
    return browser;
  }
  return {
    ...browser,
    notes: uniqueStrings([...(browser.notes ?? []), ...notes]),
  };
}

function parsePermissionGrantNotes(result: unknown): string[] {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const unsupportedPermissions = Array.isArray(record.unsupportedPermissions)
    ? record.unsupportedPermissions.filter((value): value is string => typeof value === "string")
    : [];
  const notes = ["Granted Meet microphone/camera permissions through browser control."];
  if (unsupportedPermissions.includes("speakerSelection")) {
    notes.push("Chrome did not accept the optional Meet speaker-selection permission.");
  }
  return notes;
}

async function grantMeetMediaPermissions(params: {
  callBrowser: BrowserRequestCaller;
  timeoutMs: number;
  allowMicrophone: boolean;
  targetId: string;
}): Promise<string[]> {
  if (!params.allowMicrophone) {
    return ["Observe-only mode skips Meet microphone/camera permission grants."];
  }
  try {
    const result = await params.callBrowser({
      method: "POST",
      path: "/permissions/grant",
      body: {
        origin: "https://meet.google.com",
        permissions: ["audioCapture", "videoCapture"],
        optionalPermissions: ["speakerSelection"],
        targetId: params.targetId,
        timeoutMs: Math.min(params.timeoutMs, 5_000),
      },
      timeoutMs: Math.min(params.timeoutMs, 5_000),
    });
    return parsePermissionGrantNotes(result);
  } catch (error) {
    return [
      `Could not grant Meet media permissions automatically: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

function meetStatusScript(params: {
  allowMicrophone: boolean;
  autoJoin: boolean;
  captionSessionId?: string;
  captureCaptions: boolean;
  guestName: string;
  readOnly?: boolean;
}) {
  return `async () => {
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const allowMicrophone = ${JSON.stringify(params.allowMicrophone)};
  const captionSessionId = ${JSON.stringify(params.captionSessionId)};
  const captureCaptions = ${JSON.stringify(params.captureCaptions)};
  const readOnly = ${JSON.stringify(Boolean(params.readOnly))};
  const buttons = [...document.querySelectorAll('button')];
  const buttonLabel = (button) =>
    [
      button.getAttribute("aria-label"),
      button.getAttribute("data-tooltip"),
      text(button),
    ]
      .filter(Boolean)
      .join(" ");
  const buttonLabels = buttons.map(buttonLabel).filter(Boolean);
  const notes = [];
  let audioOutputRouted;
  let audioOutputDeviceLabel;
  let audioOutputRouteError;
  const findButton = (pattern) =>
    buttons.find((button) => {
      const label = buttonLabel(button);
      return pattern.test(label) && !button.disabled;
    });
  const findCallControlButton = (pattern) =>
    buttons.find((button) => {
      const label = buttonLabel(button);
      return pattern.test(label) && !/remotely mute|someone else/i.test(label) && !button.disabled;
    });
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
  if (!readOnly && allowMicrophone && mic && /turn on microphone/i.test(buttonLabel(mic))) {
    mic.click();
    notes.push("Attempted to turn on the Meet microphone for talk-back mode.");
  }
  if (!readOnly && !allowMicrophone && mic && /turn off microphone/i.test(mic.getAttribute('aria-label') || text(mic))) {
    mic.click();
    notes.push("Muted Meet microphone for observe-only mode.");
  }
  const joinElsewhere = findButton(/join here too/i);
  const join = !readOnly && ${JSON.stringify(params.autoJoin)}
    ? findButton(/join now|ask to join/i)
    : null;
  if (join) join.click();
  const microphoneChoice = findButton(/\\buse microphone\\b/i);
  const noMicrophoneChoice = findButton(/\\b(continue|join|use) without (microphone|mic)\\b|\\bnot now\\b/i);
  if (!readOnly && allowMicrophone && microphoneChoice) {
    microphoneChoice.click();
    notes.push("Accepted Meet microphone prompt with browser automation.");
  } else if (!readOnly && !allowMicrophone && noMicrophoneChoice) {
    noMicrophoneChoice.click();
    notes.push("Skipped Meet microphone prompt for observe-only mode.");
  }
  const inCall = buttons.some((button) => /leave call/i.test(button.getAttribute('aria-label') || text(button)));
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
      const output = devices.find((device) =>
        device.kind === 'audiooutput' && /\\bBlackHole\\s+2ch\\b/i.test(device.label || '')
      ) || devices.find((device) =>
        device.kind === 'audiooutput' && /\\bBlackHole\\b/i.test(device.label || '')
      );
      if (!output?.deviceId) {
        if (devices.some((device) => device.kind === 'audiooutput')) {
          notes.push("BlackHole 2ch speaker output was not visible to Meet.");
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
      audioOutputDeviceLabel = output.label || "BlackHole 2ch";
      if (!readOnly && audioOutputRouted) {
        notes.push(
          routed > 0
            ? \`Routed Meet media output to \${audioOutputDeviceLabel}.\`
            : \`Meet media output already routed to \${audioOutputDeviceLabel}.\`
        );
      }
    } catch (error) {
      audioOutputRouteError = error?.message || String(error);
      notes.push(\`Could not route Meet speaker output to BlackHole 2ch: \${audioOutputRouteError}\`);
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
  let manualActionReason;
  let manualActionMessage;
  if (!inCall && (host === "accounts.google.com" || /use your google account|to continue to google meet|choose an account|sign in to (join|continue)/i.test(pageText))) {
    manualActionReason = "google-login-required";
    manualActionMessage = "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.";
  } else if (!inCall && joinElsewhere) {
    manualActionReason = "meet-session-conflict";
    manualActionMessage = "Meet is already active in another tab or device. Leave that session or reuse an English-pinned tab before retrying.";
  } else if (!inCall && /asking to be let in|you.?ll join when someone lets you in|waiting to be let in|ask to join/i.test(pageText)) {
    manualActionReason = "meet-admission-required";
    manualActionMessage = "Admit the OpenClaw browser participant in Google Meet, then retry speech.";
  } else if (permissionNeeded) {
    manualActionReason = "meet-permission-required";
    manualActionMessage = allowMicrophone
      ? "Allow microphone/camera/speaker permissions for Meet in the OpenClaw browser profile, then retry."
      : "Join without microphone/camera permissions in the OpenClaw browser profile, then retry.";
  } else if (!inCall && (allowMicrophone ? !microphoneChoice : !noMicrophoneChoice) && /do you want people to hear you in the meeting/i.test(pageText)) {
    manualActionReason = "meet-audio-choice-required";
    manualActionMessage = allowMicrophone
      ? "Meet is showing the microphone choice. Click Use microphone in the OpenClaw browser profile, then retry."
      : "Meet is showing the microphone choice. Choose the no-microphone option in the OpenClaw browser profile, then retry.";
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
    audioOutputRouted,
    audioOutputDeviceLabel,
    audioOutputRouteError,
    manualActionRequired: Boolean(manualActionReason),
    manualActionReason,
    manualActionMessage,
    title: document.title,
    url: pageUrl,
    notes
  });
}`;
}

function meetTranscriptScript(meetingUrl: string, meetingSessionId: string, finalize: boolean) {
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

function parseMeetTranscriptSnapshot(
  result: unknown,
): GoogleMeetTranscriptSnapshot & { sessionMatched?: boolean; urlMatched?: boolean } {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const raw = record.result;
  if (typeof raw !== "string" || !raw.trim()) {
    return { droppedLines: 0, lines: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Google Meet transcript JSON is malformed.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Google Meet transcript payload is invalid.");
  }
  const payload = parsed as {
    droppedLines?: unknown;
    epoch?: unknown;
    lines?: unknown;
    sessionMatched?: unknown;
    urlMatched?: unknown;
  };
  const droppedLines =
    typeof payload.droppedLines === "number" && Number.isSafeInteger(payload.droppedLines)
      ? Math.max(0, payload.droppedLines)
      : 0;
  const lines = Array.isArray(payload.lines)
    ? payload.lines.flatMap((value) => {
        if (!value || typeof value !== "object") {
          return [];
        }
        const line = value as { at?: unknown; speaker?: unknown; text?: unknown };
        if (typeof line.text !== "string" || !line.text.trim()) {
          return [];
        }
        return [
          {
            ...(typeof line.at === "string" ? { at: line.at } : {}),
            ...(typeof line.speaker === "string" ? { speaker: line.speaker } : {}),
            text: line.text,
          },
        ];
      })
    : [];
  return {
    droppedLines,
    ...(typeof payload.epoch === "string" ? { epoch: payload.epoch } : {}),
    lines,
    ...(typeof payload.urlMatched === "boolean" ? { urlMatched: payload.urlMatched } : {}),
    ...(typeof payload.sessionMatched === "boolean"
      ? { sessionMatched: payload.sessionMatched }
      : {}),
  };
}

async function readMeetTranscriptWithBrowserRequest(params: {
  callBrowser: BrowserRequestCaller;
  finalize: boolean;
  meetingUrl: string;
  meetingSessionId: string;
  tab: GoogleMeetBrowserTab;
  timeoutMs: number;
}): Promise<GoogleMeetTranscriptSnapshot> {
  const result = await params.callBrowser({
    method: "POST",
    path: "/act",
    body: {
      kind: "evaluate",
      targetId: params.tab.targetId,
      fn: meetTranscriptScript(params.meetingUrl, params.meetingSessionId, params.finalize),
    },
    timeoutMs: params.timeoutMs,
  });
  const snapshot = parseMeetTranscriptSnapshot(result);
  if (snapshot.urlMatched === false) {
    throw new Error("The tracked Meet tab no longer shows this session's meeting URL.");
  }
  if (snapshot.sessionMatched === false) {
    throw new Error("The tracked Meet tab now belongs to another OpenClaw meeting session.");
  }
  return {
    droppedLines: snapshot.droppedLines,
    ...(snapshot.epoch ? { epoch: snapshot.epoch } : {}),
    lines: snapshot.lines,
  };
}

function meetLeaveScript(meetingUrl: string) {
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
  if (!expectedMeetingUrl || currentMeetingUrl !== expectedMeetingUrl) {
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

function parseMeetLeaveResult(result: unknown): {
  departed: boolean;
  leaveAction?: "leave" | "confirm";
  urlMatched?: boolean;
} {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const raw = record.result;
  if (typeof raw !== "string" || !raw.trim()) {
    return { departed: false };
  }
  try {
    const parsed = JSON.parse(raw) as {
      departed?: boolean;
      leaveAction?: string;
      urlMatched?: boolean;
    };
    const leaveAction =
      parsed.leaveAction === "leave" || parsed.leaveAction === "confirm"
        ? parsed.leaveAction
        : undefined;
    return {
      departed: parsed.departed === true,
      ...(leaveAction ? { leaveAction } : {}),
      ...(typeof parsed.urlMatched === "boolean" ? { urlMatched: parsed.urlMatched } : {}),
    };
  } catch {
    return { departed: false };
  }
}

async function leaveMeetInPage(params: {
  callBrowser: BrowserRequestCaller;
  meetingUrl: string;
  targetId: string;
  timeoutMs: number;
}): Promise<{
  departed: boolean;
  clickedLeave: boolean;
  clickedConfirmation: boolean;
  urlMatched?: boolean;
}> {
  const deadline = Date.now() + params.timeoutMs;
  let clickedLeave = false;
  let clickedConfirmation = false;
  do {
    const evaluated = await params.callBrowser({
      method: "POST",
      path: "/act",
      body: {
        kind: "evaluate",
        targetId: params.targetId,
        fn: meetLeaveScript(params.meetingUrl),
      },
      timeoutMs: params.timeoutMs,
    });
    const step = parseMeetLeaveResult(evaluated);
    clickedLeave ||= step.leaveAction === "leave";
    clickedConfirmation ||= step.leaveAction === "confirm";
    if (step.departed || step.urlMatched !== true) {
      return {
        departed: step.departed,
        clickedLeave,
        clickedConfirmation,
        urlMatched: step.urlMatched,
      };
    }
    if (!step.leaveAction && !clickedLeave) {
      return { departed: false, clickedLeave, clickedConfirmation, urlMatched: true };
    }
    if (!step.leaveAction) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  } while (Date.now() < deadline);
  return { departed: false, clickedLeave, clickedConfirmation, urlMatched: true };
}

// `leave` must remove the browser participant from the call, not just flip local
// session state; otherwise the tab keeps sitting in the meeting after the CLI
// reports "left" (#103386). It acts on the exact tab identity persisted at join:
// clicking Leave call is the graceful path, and the tab is closed afterwards only
// when the plugin opened it — a reused tab belongs to the user and stays open.
async function leaveMeetWithBrowserRequest(params: {
  callBrowser: BrowserRequestCaller;
  config: GoogleMeetConfig;
  meetingUrl: string;
  tab: GoogleMeetBrowserTab;
}): Promise<{ left: boolean; note: string }> {
  if (!params.config.chrome.launch) {
    return {
      left: false,
      note: "Browser leave skipped because chrome.launch is disabled.",
    };
  }
  const timeoutMs = Math.min(Math.max(1_000, params.config.chrome.joinTimeoutMs), 5_000);
  const { targetId, openedByPlugin } = params.tab;
  try {
    const tabs = asBrowserTabs(
      await params.callBrowser({ method: "GET", path: "/tabs", timeoutMs }),
    );
    const currentTab = tabs.find((entry) => entry.targetId === targetId);
    if (!currentTab) {
      return {
        left: true,
        note: "Meet tab is already closed.",
      };
    }
    let leaveResult: Awaited<ReturnType<typeof leaveMeetInPage>>;
    try {
      leaveResult = await leaveMeetInPage({
        callBrowser: params.callBrowser,
        meetingUrl: params.meetingUrl,
        targetId,
        timeoutMs,
      });
    } catch (error) {
      return {
        left: false,
        note: `Browser control could not verify the Meet tab before leaving: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (leaveResult.urlMatched === false) {
      return {
        left: true,
        note: "Meet tab moved away from this session; left its current page untouched.",
      };
    }
    if (leaveResult.urlMatched !== true) {
      return {
        left: false,
        note: "Browser control could not verify that the tracked tab still showed this meeting.",
      };
    }
    const { clickedLeave, departed } = leaveResult;
    if (!openedByPlugin) {
      return {
        left: departed,
        note: departed
          ? "Clicked Meet's Leave call button; kept the reused browser tab open."
          : clickedLeave
            ? "Clicked Meet's Leave call button, but could not verify departure; leave it manually."
            : "Could not find Meet's Leave call button in the reused browser tab; leave it manually.",
      };
    }
    await params.callBrowser({
      method: "DELETE",
      path: `/tabs/${targetId}`,
      timeoutMs,
    });
    return {
      left: true,
      note: clickedLeave
        ? "Clicked Meet's Leave call button and closed the Meet tab."
        : "Closed the Meet tab to leave the meeting (Leave call button was not found).",
    };
  } catch (error) {
    return {
      left: false,
      note: `Browser control could not leave the Meet tab: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function leaveChromeMeet(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  meetingUrl: string;
  tab: GoogleMeetBrowserTab;
}): Promise<{ left: boolean; note: string }> {
  return await leaveMeetWithBrowserRequest({
    callBrowser: await resolveLocalBrowserRequest(params.runtime),
    config: params.config,
    meetingUrl: params.meetingUrl,
    tab: params.tab,
  });
}

export async function readChromeMeetTranscript(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  finalize?: boolean;
  meetingUrl: string;
  meetingSessionId: string;
  tab: GoogleMeetBrowserTab;
}): Promise<GoogleMeetTranscriptSnapshot> {
  return await readMeetTranscriptWithBrowserRequest({
    callBrowser: await resolveLocalBrowserRequest(params.runtime),
    finalize: params.finalize === true,
    meetingUrl: params.meetingUrl,
    meetingSessionId: params.meetingSessionId,
    tab: params.tab,
    timeoutMs: Math.min(Math.max(1_000, params.config.chrome.joinTimeoutMs), 10_000),
  });
}

export async function readChromeMeetTranscriptOnNode(params: {
  runtime: PluginRuntime;
  nodeId?: string;
  config: GoogleMeetConfig;
  finalize?: boolean;
  meetingUrl: string;
  meetingSessionId: string;
  tab: GoogleMeetBrowserTab;
}): Promise<GoogleMeetTranscriptSnapshot> {
  const nodeId =
    params.nodeId ??
    (await resolveChromeNode({
      runtime: params.runtime,
      requestedNode: params.config.chromeNode.node,
    }));
  const timeoutMs = Math.min(Math.max(1_000, params.config.chrome.joinTimeoutMs), 10_000);
  return await readMeetTranscriptWithBrowserRequest({
    callBrowser: async (request) =>
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId,
        method: request.method,
        path: request.path,
        body: request.body,
        timeoutMs: request.timeoutMs,
      }),
    finalize: params.finalize === true,
    meetingUrl: params.meetingUrl,
    meetingSessionId: params.meetingSessionId,
    tab: params.tab,
    timeoutMs,
  });
}

export async function leaveChromeMeetOnNode(params: {
  runtime: PluginRuntime;
  nodeId?: string;
  config: GoogleMeetConfig;
  meetingUrl: string;
  tab: GoogleMeetBrowserTab;
}): Promise<{ left: boolean; note: string }> {
  const nodeId =
    params.nodeId ??
    (await resolveChromeNode({
      runtime: params.runtime,
      requestedNode: params.config.chromeNode.node,
    }));
  return await leaveMeetWithBrowserRequest({
    callBrowser: async (request) =>
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId,
        method: request.method,
        path: request.path,
        body: request.body,
        timeoutMs: request.timeoutMs,
      }),
    config: params.config,
    meetingUrl: params.meetingUrl,
    tab: params.tab,
  });
}

async function openMeetWithBrowserProxy(params: {
  runtime: PluginRuntime;
  nodeId: string;
  config: GoogleMeetConfig;
  mode: GoogleMeetMode;
  meetingSessionId: string;
  url: string;
}): Promise<{ launched: boolean; browser?: GoogleMeetChromeHealth; tab?: GoogleMeetBrowserTab }> {
  return await openMeetWithBrowserRequest({
    callBrowser: async (request) =>
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId: params.nodeId,
        method: request.method,
        path: request.path,
        body: request.body,
        timeoutMs: request.timeoutMs,
      }),
    config: params.config,
    mode: params.mode,
    meetingSessionId: params.meetingSessionId,
    url: params.url,
  });
}

async function openMeetWithBrowserRequest(params: {
  callBrowser: BrowserRequestCaller;
  config: GoogleMeetConfig;
  mode: GoogleMeetMode;
  meetingSessionId: string;
  url: string;
}): Promise<{ launched: boolean; browser?: GoogleMeetChromeHealth; tab?: GoogleMeetBrowserTab }> {
  if (!params.config.chrome.launch) {
    return { launched: false };
  }

  const timeoutMs = Math.max(1_000, params.config.chrome.joinTimeoutMs);
  let targetId: string | undefined;
  let tab: BrowserTab | undefined;
  let openUrl = params.url;
  let openedByPlugin = false;
  if (params.config.chrome.reuseExistingTab) {
    const tabs = asBrowserTabs(
      await params.callBrowser({
        method: "GET",
        path: "/tabs",
        timeoutMs: Math.min(timeoutMs, 5_000),
      }),
    );
    const matchingTabs = tabs.filter((entry) => isSameMeetUrlForReuse(entry.url, params.url));
    const requestedAuthUser = readMeetAuthUser(params.url);
    tab = matchingTabs.find(
      (entry) =>
        isEnglishMeetTab(entry.url) &&
        (!requestedAuthUser || readMeetAuthUser(entry.url) === requestedAuthUser),
    );
    if (!tab) {
      const requestedUrl = new URL(params.url);
      if (!requestedUrl.searchParams.has("authuser")) {
        openUrl = matchingTabs.find((entry) => entry.url)?.url ?? params.url;
      }
    }
    targetId = tab?.targetId;
    if (tab && targetId) {
      await params.callBrowser({
        method: "POST",
        path: "/tabs/focus",
        body: { targetId },
        timeoutMs: Math.min(timeoutMs, 5_000),
      });
    }
  }
  if (!targetId) {
    tab = readBrowserTab(
      await params.callBrowser({
        method: "POST",
        path: "/tabs/open",
        body: { url: forceMeetEnglishUi(openUrl) },
        timeoutMs,
      }),
    );
    targetId = tab?.targetId;
    openedByPlugin = Boolean(targetId);
  }
  if (!targetId) {
    return {
      launched: true,
      browser: {
        status: "browser-control",
        notes: ["Browser proxy opened Meet but did not return a targetId."],
        browserUrl: tab?.url,
        browserTitle: tab?.title,
      },
    };
  }

  const tabIdentity: GoogleMeetBrowserTab = { targetId, openedByPlugin };
  const permissionNotes = await grantMeetMediaPermissions({
    allowMicrophone: isGoogleMeetTalkBackMode(params.mode),
    callBrowser: params.callBrowser,
    targetId,
    timeoutMs,
  });
  const deadline = Date.now() + Math.max(0, params.config.chrome.waitForInCallMs);
  let browser: GoogleMeetChromeHealth | undefined = {
    status: "browser-control",
    browserUrl: tab?.url,
    browserTitle: tab?.title,
    notes: permissionNotes,
  };
  do {
    try {
      const evaluated = await params.callBrowser({
        method: "POST",
        path: "/act",
        body: {
          kind: "evaluate",
          targetId,
          fn: meetStatusScript({
            allowMicrophone: isGoogleMeetTalkBackMode(params.mode),
            captionSessionId: params.meetingSessionId,
            captureCaptions: params.mode === "transcribe",
            guestName: params.config.chrome.guestName,
            autoJoin: params.config.chrome.autoJoin,
          }),
        },
        timeoutMs: Math.min(timeoutMs, 10_000),
      });
      browser = mergeBrowserNotes(parseMeetBrowserStatus(evaluated) ?? browser, permissionNotes);
      if (
        browser?.inCall === true &&
        (!isGoogleMeetTalkBackMode(params.mode) || browser.micMuted !== true)
      ) {
        return { launched: true, browser, tab: tabIdentity };
      }
      if (browser?.manualActionRequired === true) {
        return { launched: true, browser, tab: tabIdentity };
      }
    } catch (error) {
      browser = {
        ...browser,
        inCall: false,
        manualActionRequired: true,
        manualActionReason: "browser-control-unavailable",
        manualActionMessage:
          "Open the OpenClaw browser profile, finish Google Meet login, admission, or permission prompts, then retry.",
        notes: [
          ...permissionNotes,
          `Browser control could not inspect or auto-join Meet: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
      break;
    }
    const remainingWaitMs = deadline - Date.now();
    if (remainingWaitMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(750, remainingWaitMs));
      });
    }
  } while (Date.now() < deadline);
  return { launched: true, browser, tab: tabIdentity };
}

function isRecoverableMeetTab(tab: BrowserTab, url?: string): boolean {
  if (url) {
    return isSameMeetUrlForReuse(tab.url, url);
  }
  if (normalizeMeetUrlForReuse(tab.url)) {
    return true;
  }
  const tabUrl = tab.url ?? "";
  return (
    tabUrl.startsWith("https://accounts.google.com/") &&
    /sign in|google accounts|meet/i.test(tab.title ?? "")
  );
}

function findRecoverableMeetTab(tabs: BrowserTab[], url?: string): BrowserTab | undefined {
  const candidates = tabs.filter((tab) => isRecoverableMeetTab(tab, url));
  if (!url) {
    return candidates[0];
  }
  const requestedAuthUser = readMeetAuthUser(url);
  const accountCandidates = requestedAuthUser
    ? candidates.filter((tab) => readMeetAuthUser(tab.url) === requestedAuthUser)
    : candidates;
  return accountCandidates.find((tab) => isEnglishMeetTab(tab.url)) ?? accountCandidates[0];
}

async function inspectRecoverableMeetTab(params: {
  callBrowser: BrowserRequestCaller;
  config: GoogleMeetConfig;
  mode?: GoogleMeetMode;
  readOnly?: boolean;
  timeoutMs: number;
  tab: BrowserTab;
  targetId: string;
}) {
  const allowMicrophone = params.mode !== "transcribe";
  await params.callBrowser({
    method: "POST",
    path: "/tabs/focus",
    body: { targetId: params.targetId },
    timeoutMs: Math.min(params.timeoutMs, 5_000),
  });
  // Recovery must never reload an unknown meeting-code tab: it may be an active
  // call. English-only automation can safely inspect only tabs pinned by us.
  if (normalizeMeetUrlForReuse(params.tab.url) && !isEnglishMeetTab(params.tab.url)) {
    const manualActionMessage =
      "The existing Meet tab is not pinned to English. Open the meeting with ?hl=en, then retry recovery.";
    return {
      found: true,
      targetId: params.targetId,
      tab: params.tab,
      browser: {
        status: "browser-control" as const,
        browserUrl: params.tab.url,
        browserTitle: params.tab.title,
        manualActionRequired: true,
        manualActionReason: "meet-locale-required" as const,
        manualActionMessage,
      },
      message: manualActionMessage,
    };
  }
  const permissionNotes = params.readOnly
    ? []
    : await grantMeetMediaPermissions({
        allowMicrophone,
        callBrowser: params.callBrowser,
        targetId: params.targetId,
        timeoutMs: params.timeoutMs,
      });
  const evaluated = await params.callBrowser({
    method: "POST",
    path: "/act",
    body: {
      kind: "evaluate",
      targetId: params.targetId,
      fn: meetStatusScript({
        allowMicrophone,
        captureCaptions: params.mode === "transcribe",
        guestName: params.config.chrome.guestName,
        autoJoin: false,
        readOnly: params.readOnly,
      }),
    },
    timeoutMs: Math.min(params.timeoutMs, 10_000),
  });
  const browser = mergeBrowserNotes(
    parseMeetBrowserStatus(evaluated) ?? {
      status: "browser-control",
      browserUrl: params.tab.url,
      browserTitle: params.tab.title,
    },
    permissionNotes,
  );
  const manual = browser?.manualActionRequired
    ? browser.manualActionMessage || browser.manualActionReason
    : undefined;
  return {
    found: true,
    targetId: params.targetId,
    tab: params.tab,
    browser,
    message:
      manual ?? (browser?.inCall ? "Existing Meet tab is in-call." : "Existing Meet tab focused."),
  };
}

export async function recoverCurrentMeetTab(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  mode?: GoogleMeetMode;
  readOnly?: boolean;
  url?: string;
}): Promise<{
  transport: "chrome";
  nodeId?: undefined;
  found: boolean;
  targetId?: string;
  tab?: BrowserTab;
  browser?: GoogleMeetChromeHealth;
  message: string;
}> {
  const timeoutMs = Math.max(1_000, params.config.chrome.joinTimeoutMs);
  const callBrowser = await resolveLocalBrowserRequest(params.runtime);
  const tabs = asBrowserTabs(
    await callBrowser({
      method: "GET",
      path: "/tabs",
      timeoutMs: Math.min(timeoutMs, 5_000),
    }),
  );
  const tab = findRecoverableMeetTab(tabs, params.url);
  const targetId = tab?.targetId;
  if (!tab || !targetId) {
    return {
      transport: "chrome",
      found: false,
      tab,
      message: params.url
        ? `No existing Meet tab matched ${params.url}.`
        : "No existing Meet tab found in local Chrome.",
    };
  }
  return {
    transport: "chrome",
    ...(await inspectRecoverableMeetTab({
      callBrowser,
      config: params.config,
      mode: params.mode,
      readOnly: params.readOnly,
      timeoutMs,
      tab,
      targetId,
    })),
  };
}

export async function recoverCurrentMeetTabOnNode(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  mode?: GoogleMeetMode;
  readOnly?: boolean;
  url?: string;
}): Promise<{
  transport: "chrome-node";
  nodeId: string;
  found: boolean;
  targetId?: string;
  tab?: BrowserTab;
  browser?: GoogleMeetChromeHealth;
  message: string;
}> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  const timeoutMs = Math.max(1_000, params.config.chrome.joinTimeoutMs);
  const tabs = asBrowserTabs(
    await callBrowserProxyOnNode({
      runtime: params.runtime,
      nodeId,
      method: "GET",
      path: "/tabs",
      timeoutMs: Math.min(timeoutMs, 5_000),
    }),
  );
  const tab = findRecoverableMeetTab(tabs, params.url);
  const targetId = tab?.targetId;
  if (!tab || !targetId) {
    return {
      transport: "chrome-node",
      nodeId,
      found: false,
      tab,
      message: params.url
        ? `No existing Meet tab matched ${params.url}.`
        : "No existing Meet tab found on the selected Chrome node.",
    };
  }
  return {
    transport: "chrome-node",
    nodeId,
    ...(await inspectRecoverableMeetTab({
      callBrowser: async (request) =>
        await callBrowserProxyOnNode({
          runtime: params.runtime,
          nodeId,
          method: request.method,
          path: request.path,
          body: request.body,
          timeoutMs: request.timeoutMs,
        }),
      config: params.config,
      mode: params.mode,
      readOnly: params.readOnly,
      timeoutMs,
      tab,
      targetId,
    })),
  };
}

export async function launchChromeMeetOnNode(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  requesterSessionKey?: string;
  mode: GoogleMeetMode;
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  nodeId: string;
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "node-command-pair" } & ChromeNodeRealtimeAudioBridgeHandle);
  browser?: GoogleMeetChromeHealth;
  tab?: GoogleMeetBrowserTab;
}> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  try {
    await params.runtime.nodes.invoke({
      nodeId,
      command: "googlemeet.chrome",
      params: {
        action: "stopByUrl",
        url: params.url,
        mode: params.mode,
      },
      timeoutMs: 5_000,
    });
  } catch (error) {
    params.logger.debug?.(
      `[google-meet] node bridge cleanup before join ignored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const browserControl = await openMeetWithBrowserProxy({
    runtime: params.runtime,
    nodeId,
    config: params.config,
    mode: params.mode,
    meetingSessionId: params.meetingSessionId,
    url: params.url,
  });
  const raw = await params.runtime.nodes.invoke({
    nodeId,
    command: "googlemeet.chrome",
    params: {
      action: "start",
      url: params.url,
      mode: params.mode,
      launch: false,
      browserProfile: params.config.chrome.browserProfile,
      joinTimeoutMs: params.config.chrome.joinTimeoutMs,
      audioInputCommand: params.config.chrome.audioInputCommand,
      audioOutputCommand: params.config.chrome.audioOutputCommand,
      audioBridgeCommand: params.config.chrome.audioBridgeCommand,
      audioBridgeHealthCommand: params.config.chrome.audioBridgeHealthCommand,
    },
    timeoutMs: addTimerTimeoutGraceMs(params.config.chrome.joinTimeoutMs) ?? 1,
  });
  const result = parseNodeStartResult(raw);
  if (result.audioBridge?.type === "node-command-pair") {
    if (!result.bridgeId) {
      throw new Error("Google Meet node did not return an audio bridge id.");
    }
    const bridge = await (
      params.mode === "agent" ? startNodeAgentAudioBridge : startNodeRealtimeAudioBridge
    )({
      config:
        params.mode === "agent"
          ? params.config
          : {
              ...params.config,
              realtime: { ...params.config.realtime, strategy: "bidi" },
            },
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      meetingSessionId: params.meetingSessionId,
      requesterSessionKey: params.requesterSessionKey,
      nodeId,
      bridgeId: result.bridgeId,
      logger: params.logger,
    });
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBridge: bridge,
      browser: browserControl.browser ?? result.browser,
      tab: browserControl.tab,
    };
  }
  if (result.audioBridge?.type === "external-command") {
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBridge: { type: "external-command" },
      browser: browserControl.browser ?? result.browser,
      tab: browserControl.tab,
    };
  }
  return {
    nodeId,
    launched: browserControl.launched || result.launched === true,
    browser: browserControl.browser ?? result.browser,
    tab: browserControl.tab,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
