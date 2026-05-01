import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig } from "../config.js";
import {
  startNodeRealtimeAudioBridge,
  type ChromeNodeRealtimeAudioBridgeHandle,
} from "../realtime-node.js";
import {
  startCommandRealtimeAudioBridge,
  type ChromeRealtimeAudioBridgeHandle,
} from "../realtime.js";
import {
  asBrowserTabs,
  callBrowserProxyOnNode,
  isSameMeetUrlForReuse,
  normalizeMeetUrlForReuse,
  readBrowserTab,
  resolveChromeNode,
  type BrowserTab,
} from "./chrome-browser-proxy.js";
import type { GoogleMeetChromeHealth } from "./types.js";

export const GOOGLE_MEET_SYSTEM_PROFILER_COMMAND = "/usr/sbin/system_profiler";

type BrowserRequestParams = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
};

type BrowserRequestCaller = (params: BrowserRequestParams) => Promise<unknown>;

const chromeTransportDeps: {
  callGatewayFromCli: typeof callGatewayFromCli;
} = {
  callGatewayFromCli,
};

export const __testing = {
  setDepsForTest(deps: { callGatewayFromCli?: typeof callGatewayFromCli } | null) {
    chromeTransportDeps.callGatewayFromCli = deps?.callGatewayFromCli ?? callGatewayFromCli;
  },
  meetStatusScriptForTest: meetStatusScript,
};

export function outputMentionsBlackHole2ch(output: string): boolean {
  return /\bBlackHole\s+2ch\b/i.test(output);
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
  mode: "realtime" | "transcribe";
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle);
  browser?: GoogleMeetChromeHealth;
}> {
  let audioBridge:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle)
    | undefined;

  if (params.mode === "realtime") {
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

    if (params.config.chrome.audioBridgeCommand) {
      const bridge = await params.runtime.system.runCommandWithTimeout(
        params.config.chrome.audioBridgeCommand,
        { timeoutMs: params.config.chrome.joinTimeoutMs },
      );
      if (bridge.code !== 0) {
        throw new Error(
          `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
        );
      }
      audioBridge = { type: "external-command" };
    } else {
      if (!params.config.chrome.audioInputCommand || !params.config.chrome.audioOutputCommand) {
        throw new Error(
          "Chrome realtime mode requires chrome.audioInputCommand and chrome.audioOutputCommand, or chrome.audioBridgeCommand for an external bridge.",
        );
      }
      audioBridge = {
        type: "command-pair",
        ...(await startCommandRealtimeAudioBridge({
          config: params.config,
          fullConfig: params.fullConfig,
          runtime: params.runtime,
          meetingSessionId: params.meetingSessionId,
          inputCommand: params.config.chrome.audioInputCommand,
          outputCommand: params.config.chrome.audioOutputCommand,
          logger: params.logger,
        })),
      };
    }
  }

  if (!params.config.chrome.launch) {
    return { launched: false, audioBridge };
  }

  let commandPairBridgeStopped = false;
  const stopCommandPairBridge = async () => {
    if (commandPairBridgeStopped) {
      return;
    }
    commandPairBridgeStopped = true;
    if (audioBridge?.type === "command-pair") {
      await audioBridge.stop();
    }
  };

  try {
    const result = await openMeetWithBrowserRequest({
      callBrowser: callLocalBrowserRequest,
      config: params.config,
      mode: params.mode,
      url: params.url,
    });
    return { ...result, audioBridge };
  } catch (error) {
    await stopCommandPairBridge();
    throw error;
  }
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
  const parsed = JSON.parse(raw) as {
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
    manualActionRequired?: boolean;
    manualActionReason?: GoogleMeetChromeHealth["manualActionReason"];
    manualActionMessage?: string;
    url?: string;
    title?: string;
    notes?: string[];
  };
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
  return await chromeTransportDeps.callGatewayFromCli(
    "browser.request",
    {
      json: true,
      timeout: String(params.timeoutMs + 5_000),
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

function mergeBrowserNotes(
  browser: GoogleMeetChromeHealth | undefined,
  notes: string[],
): GoogleMeetChromeHealth | undefined {
  if (!browser || notes.length === 0) {
    return browser;
  }
  return {
    ...browser,
    notes: [...new Set([...(browser.notes ?? []), ...notes])],
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
  captureCaptions: boolean;
  guestName: string;
}) {
  return `() => {
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const allowMicrophone = ${JSON.stringify(params.allowMicrophone)};
  const captureCaptions = ${JSON.stringify(params.captureCaptions)};
  const buttons = [...document.querySelectorAll('button')];
  const notes = [];
  const findButton = (pattern) =>
    buttons.find((button) => {
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("data-tooltip"),
        text(button),
      ]
        .filter(Boolean)
        .join(" ");
      return pattern.test(label) && !button.disabled;
    });
  const input = [...document.querySelectorAll('input')].find((el) =>
    /your name/i.test(el.getAttribute('aria-label') || el.placeholder || '')
  );
  if (${JSON.stringify(params.autoJoin)} && input && !input.value) {
    input.focus();
    input.value = ${JSON.stringify(params.guestName)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const pageText = text(document.body).toLowerCase();
  const host = location.hostname.toLowerCase();
  const pageUrl = location.href;
  const permissionNeeded = /permission needed|allow.*(microphone|camera)|blocked.*(microphone|camera)|permission.*(microphone|camera|speaker)/i.test(pageText);
  const mic = buttons.find((button) => /turn off microphone|turn on microphone|microphone/i.test(button.getAttribute('aria-label') || text(button)));
  if (!allowMicrophone && mic && /turn off microphone/i.test(mic.getAttribute('aria-label') || text(mic))) {
    mic.click();
    notes.push("Muted Meet microphone for observe-only mode.");
  }
  const join = ${JSON.stringify(params.autoJoin)}
    ? findButton(/join now|ask to join/i)
    : null;
  if (join) join.click();
  const microphoneChoice = findButton(/\\buse microphone\\b/i);
  const noMicrophoneChoice = findButton(/\\b(continue|join|use) without (microphone|mic)\\b|\\bnot now\\b/i);
  if (allowMicrophone && microphoneChoice) {
    microphoneChoice.click();
    notes.push("Accepted Meet microphone prompt with browser automation.");
  } else if (!allowMicrophone && noMicrophoneChoice) {
    noMicrophoneChoice.click();
    notes.push("Skipped Meet microphone prompt for observe-only mode.");
  }
  const inCall = buttons.some((button) => /leave call/i.test(button.getAttribute('aria-label') || text(button)));
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
    if (!w.__openclawMeetCaptions) {
      w.__openclawMeetCaptions = {
        enabledAttempted: false,
        observerInstalled: false,
        lines: [],
        seen: {}
      };
    }
    return w.__openclawMeetCaptions;
  })();
  const recordCaption = (speaker, captionText) => {
    if (!captionState) return;
    const clean = String(captionText || "").replace(/\\s+/g, " ").trim();
    const cleanSpeaker = String(speaker || "").replace(/\\s+/g, " ").trim();
    if (!clean || clean.length < 2) return;
    if (/^(turn on captions|turn off captions|captions)$/i.test(clean)) return;
    const key = (cleanSpeaker + "\\n" + clean).toLowerCase();
    if (captionState.seen[key]) return;
    captionState.seen[key] = true;
    const entry = { at: new Date().toISOString(), speaker: cleanSpeaker || undefined, text: clean };
    captionState.lines.push(entry);
    if (captionState.lines.length > 50) captionState.lines.splice(0, captionState.lines.length - 50);
  };
  const scrapeCaptions = () => {
    if (!captionState) return;
    const regions = [...document.querySelectorAll(captionSelector)];
    for (const region of regions) {
      const raw = text(region);
      if (!raw) continue;
      const pieces = raw.split(/\\n+/).map((part) => part.trim()).filter(Boolean);
      if (pieces.length >= 2) {
        recordCaption(pieces[0], pieces.slice(1).join(" "));
      } else {
        recordCaption("", pieces[0] || raw);
      }
    }
  };
  if (captionState) {
    if (inCall && !captionState.enabledAttempted) {
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
      new MutationObserver(scrapeCaptions).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
      notes.push("Installed Meet caption observer for observe-only transcript health.");
    }
    if (inCall) {
      scrapeCaptions();
    }
    const lines = Array.isArray(captionState.lines) ? captionState.lines : [];
    const last = lines[lines.length - 1];
    captioning = document.querySelector(captionSelector) !== null || lines.length > 0;
    transcriptLines = lines.length;
    lastCaptionAt = last?.at;
    lastCaptionSpeaker = last?.speaker;
    lastCaptionText = last?.text;
    recentTranscript = lines.slice(-5);
  }
  const lobbyWaiting = !inCall && /asking to be let in|you.?ll join when someone lets you in|waiting to be let in|ask to join/i.test(pageText);
  const leaveReason = /you left the meeting|you.?ve left the meeting|removed from the meeting|you were removed|call ended|meeting ended/i.test(pageText)
    ? pageText.match(/you left the meeting|you.?ve left the meeting|removed from the meeting|you were removed|call ended|meeting ended/i)?.[0]
    : undefined;
  let manualActionReason;
  let manualActionMessage;
  if (!inCall && (host === "accounts.google.com" || /use your google account|to continue to google meet|choose an account|sign in to (join|continue)/i.test(pageText))) {
    manualActionReason = "google-login-required";
    manualActionMessage = "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.";
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
    micMuted: mic ? /turn on microphone/i.test(mic.getAttribute('aria-label') || text(mic)) : undefined,
    lobbyWaiting,
    leaveReason,
    captioning,
    captionsEnabledAttempted,
    transcriptLines,
    lastCaptionAt,
    lastCaptionSpeaker,
    lastCaptionText,
    recentTranscript,
    manualActionRequired: Boolean(manualActionReason),
    manualActionReason,
    manualActionMessage,
    title: document.title,
    url: pageUrl,
    notes
  });
}`;
}

async function openMeetWithBrowserProxy(params: {
  runtime: PluginRuntime;
  nodeId: string;
  config: GoogleMeetConfig;
  mode: "realtime" | "transcribe";
  url: string;
}): Promise<{ launched: boolean; browser?: GoogleMeetChromeHealth }> {
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
    url: params.url,
  });
}

async function openMeetWithBrowserRequest(params: {
  callBrowser: BrowserRequestCaller;
  config: GoogleMeetConfig;
  mode: "realtime" | "transcribe";
  url: string;
}): Promise<{ launched: boolean; browser?: GoogleMeetChromeHealth }> {
  if (!params.config.chrome.launch) {
    return { launched: false };
  }

  const timeoutMs = Math.max(1_000, params.config.chrome.joinTimeoutMs);
  let targetId: string | undefined;
  let tab: BrowserTab | undefined;
  if (params.config.chrome.reuseExistingTab) {
    const tabs = asBrowserTabs(
      await params.callBrowser({
        method: "GET",
        path: "/tabs",
        timeoutMs: Math.min(timeoutMs, 5_000),
      }),
    );
    tab = tabs.find((entry) => isSameMeetUrlForReuse(entry.url, params.url));
    targetId = tab?.targetId;
    if (targetId) {
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
        body: { url: params.url },
        timeoutMs,
      }),
    );
    targetId = tab?.targetId;
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

  const permissionNotes = await grantMeetMediaPermissions({
    allowMicrophone: params.mode === "realtime",
    callBrowser: params.callBrowser,
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
            allowMicrophone: params.mode === "realtime",
            captureCaptions: params.mode === "transcribe",
            guestName: params.config.chrome.guestName,
            autoJoin: params.config.chrome.autoJoin,
          }),
        },
        timeoutMs: Math.min(timeoutMs, 10_000),
      });
      browser = mergeBrowserNotes(parseMeetBrowserStatus(evaluated) ?? browser, permissionNotes);
      if (browser?.inCall === true) {
        return { launched: true, browser };
      }
      if (browser?.manualActionRequired === true) {
        return { launched: true, browser };
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
    if (Date.now() <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  } while (Date.now() <= deadline);
  return { launched: true, browser };
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

async function inspectRecoverableMeetTab(params: {
  callBrowser: BrowserRequestCaller;
  config: GoogleMeetConfig;
  mode?: "realtime" | "transcribe";
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
  const permissionNotes = await grantMeetMediaPermissions({
    allowMicrophone,
    callBrowser: params.callBrowser,
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
  config: GoogleMeetConfig;
  mode?: "realtime" | "transcribe";
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
  const tabs = asBrowserTabs(
    await callLocalBrowserRequest({
      method: "GET",
      path: "/tabs",
      timeoutMs: Math.min(timeoutMs, 5_000),
    }),
  );
  const tab = tabs.find((entry) => isRecoverableMeetTab(entry, params.url));
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
      callBrowser: callLocalBrowserRequest,
      config: params.config,
      mode: params.mode,
      timeoutMs,
      tab,
      targetId,
    })),
  };
}

export async function recoverCurrentMeetTabOnNode(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  mode?: "realtime" | "transcribe";
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
  const tab = tabs.find((entry) => isRecoverableMeetTab(entry, params.url));
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
  mode: "realtime" | "transcribe";
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  nodeId: string;
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "node-command-pair" } & ChromeNodeRealtimeAudioBridgeHandle);
  browser?: GoogleMeetChromeHealth;
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
    timeoutMs: params.config.chrome.joinTimeoutMs + 5_000,
  });
  const result = parseNodeStartResult(raw);
  if (result.audioBridge?.type === "node-command-pair") {
    if (!result.bridgeId) {
      throw new Error("Google Meet node did not return an audio bridge id.");
    }
    const bridge = await startNodeRealtimeAudioBridge({
      config: params.config,
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      meetingSessionId: params.meetingSessionId,
      nodeId,
      bridgeId: result.bridgeId,
      logger: params.logger,
    });
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBridge: bridge,
      browser: browserControl.browser ?? result.browser,
    };
  }
  if (result.audioBridge?.type === "external-command") {
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBridge: { type: "external-command" },
      browser: browserControl.browser ?? result.browser,
    };
  }
  return {
    nodeId,
    launched: browserControl.launched || result.launched === true,
    browser: browserControl.browser ?? result.browser,
  };
}
