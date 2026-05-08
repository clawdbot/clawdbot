import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import type { GoogleMeetConfig } from "../config.js";
import {
  asBrowserTabs,
  callBrowserProxyOnNode,
  readBrowserTab,
  resolveChromeNode,
  type BrowserTab,
} from "./chrome-browser-proxy.js";
import type { GoogleMeetChromeHealth } from "./types.js";

const GOOGLE_MEET_NEW_URL = "https://meet.google.com/new";
const GOOGLE_MEET_BROWSER_CREATE_TIMEOUT_MS = 60_000;
const GOOGLE_MEET_BROWSER_STEP_TIMEOUT_MS = 10_000;
const GOOGLE_MEET_BROWSER_NAVIGATION_RETRY_MS = 1_000;
const GOOGLE_MEET_BROWSER_POLL_MS = 500;

type BrowserCreateStepResult = {
  meetingUri?: string;
  browserUrl?: string;
  browserTitle?: string;
  manualAction?: string;
  manualActionReason?: GoogleMeetChromeHealth["manualActionReason"];
  notes?: string[];
  retryAfterMs?: number;
};

type GoogleMeetBrowserCreateResult = {
  meetingUri: string;
  nodeId: string;
  targetId?: string;
  browserUrl?: string;
  browserTitle?: string;
  notes?: string[];
  source: "browser";
};

type GoogleMeetBrowserManualAction = {
  source: "browser";
  error: string;
  manualActionRequired: true;
  manualActionReason?: GoogleMeetChromeHealth["manualActionReason"];
  manualActionMessage: string;
  browser: {
    nodeId: string;
    targetId?: string;
    browserUrl?: string;
    browserTitle?: string;
    notes?: string[];
  };
};

class GoogleMeetBrowserManualActionError extends Error {
  readonly payload: GoogleMeetBrowserManualAction;

  constructor(payload: Omit<GoogleMeetBrowserManualAction, "source" | "error">) {
    const prefix = payload.manualActionReason ? `${payload.manualActionReason}: ` : "";
    super(`${prefix}${payload.manualActionMessage}`);
    this.name = "GoogleMeetBrowserManualActionError";
    this.payload = {
      source: "browser",
      error: this.message,
      ...payload,
    };
  }
}

export function isGoogleMeetBrowserManualActionError(
  error: unknown,
): error is GoogleMeetBrowserManualActionError {
  return error instanceof GoogleMeetBrowserManualActionError;
}

function formatBrowserAutomationError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function isBrowserNavigationInterruption(error: unknown): boolean {
  return /execution context was destroyed|navigation|target closed/i.test(
    formatBrowserAutomationError(error),
  );
}

function isGoogleMeetCreateTab(tab: BrowserTab): boolean {
  const url = tab.url ?? "";
  if (/^https:\/\/meet\.google\.com\/(?:new|[a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i.test(url)) {
    return true;
  }
  return (
    url.startsWith("https://accounts.google.com/") &&
    /sign in|google accounts|meet/i.test(tab.title ?? "")
  );
}

async function findGoogleMeetCreateTab(params: {
  runtime: PluginRuntime;
  nodeId: string;
  timeoutMs: number;
}): Promise<BrowserTab | undefined> {
  const tabs = asBrowserTabs(
    await callBrowserProxyOnNode({
      runtime: params.runtime,
      nodeId: params.nodeId,
      method: "GET",
      path: "/tabs",
      timeoutMs: params.timeoutMs,
    }),
  );
  return tabs.find(isGoogleMeetCreateTab);
}

async function focusBrowserTab(params: {
  runtime: PluginRuntime;
  nodeId: string;
  targetId: string;
  timeoutMs: number;
}): Promise<void> {
  await callBrowserProxyOnNode({
    runtime: params.runtime,
    nodeId: params.nodeId,
    method: "POST",
    path: "/tabs/focus",
    body: { targetId: params.targetId },
    timeoutMs: params.timeoutMs,
  });
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function readBrowserCreateResult(result: unknown): BrowserCreateStepResult {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const nested =
    record.result && typeof record.result === "object"
      ? (record.result as Record<string, unknown>)
      : record;
  return {
    meetingUri: typeof nested.meetingUri === "string" ? nested.meetingUri : undefined,
    browserUrl: typeof nested.browserUrl === "string" ? nested.browserUrl : undefined,
    browserTitle: typeof nested.browserTitle === "string" ? nested.browserTitle : undefined,
    manualAction: typeof nested.manualAction === "string" ? nested.manualAction : undefined,
    manualActionReason:
      typeof nested.manualActionReason === "string"
        ? (nested.manualActionReason as GoogleMeetChromeHealth["manualActionReason"])
        : undefined,
    notes: readStringArray(nested.notes),
    retryAfterMs:
      typeof nested.retryAfterMs === "number" && Number.isFinite(nested.retryAfterMs)
        ? nested.retryAfterMs
        : undefined,
  };
}

export const CREATE_MEET_FROM_BROWSER_SCRIPT = `async () => {
  const meetUrlPattern = /^https:\\/\\/meet\\.google\\.com\\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:$|[/?#])/i;
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const current = () => location.href;
  const notes = [];
  const findButton = (pattern) =>
    [...document.querySelectorAll("button")].find((button) => {
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("data-tooltip"),
        text(button),
      ]
        .filter(Boolean)
        .join(" ");
      return pattern.test(label) && !button.disabled;
    });
  const clickButton = (pattern, note) => {
    const button = findButton(pattern);
    if (!button) {
      return false;
    }
    button.click();
    notes.push(note);
    return true;
  };
  if (!current().startsWith("https://meet.google.com/")) {
    return {
      manualActionReason: "google-login-required",
      manualAction: "Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: current(),
      browserTitle: document.title,
      notes,
    };
  }
  const href = current();
  if (meetUrlPattern.test(href)) {
    return { meetingUri: href, browserUrl: href, browserTitle: document.title, notes };
  }
  const pageText = text(document.body);
  if (clickButton(/\\buse microphone\\b/i, "Accepted Meet microphone prompt with browser automation.")) {
    return { browserUrl: href, browserTitle: document.title, notes, retryAfterMs: 1000 };
  }
  if (
    clickButton(
      /continue without microphone/i,
      "Continued through Meet microphone prompt with browser automation.",
    )
  ) {
    return { browserUrl: href, browserTitle: document.title, notes, retryAfterMs: 1000 };
  }
  if (/do you want people to hear you in the meeting/i.test(pageText)) {
    return {
      manualActionReason: "meet-audio-choice-required",
      manualAction: "Meet is showing the microphone choice. Click Use microphone in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: href,
      browserTitle: document.title,
      notes,
    };
  }
  if (/allow.*(microphone|camera)|blocked.*(microphone|camera)|permission.*(microphone|camera)/i.test(pageText)) {
    return {
      manualActionReason: "meet-permission-required",
      manualAction: "Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: href,
      browserTitle: document.title,
      notes,
    };
  }
  if (/couldn't create|unable to create/i.test(pageText)) {
    return {
      manualAction: "Resolve the Google Meet page prompt in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: href,
      browserTitle: document.title,
      notes,
    };
  }
  if (location.hostname.toLowerCase() === "accounts.google.com" || /use your google account|to continue to google meet|choose an account|sign in to (join|continue)/i.test(pageText)) {
    return {
      manualActionReason: "google-login-required",
      manualAction: "Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: href,
      browserTitle: document.title,
      notes,
    };
  }
  return {
    retryAfterMs: 500,
    browserUrl: current(),
    browserTitle: document.title,
    notes,
  };
}`;

export async function createMeetWithBrowserProxyOnNode(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
}): Promise<GoogleMeetBrowserCreateResult> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  const timeoutMs = Math.max(
    GOOGLE_MEET_BROWSER_CREATE_TIMEOUT_MS,
    params.config.chrome.joinTimeoutMs,
  );
  const stepTimeoutMs = Math.min(timeoutMs, GOOGLE_MEET_BROWSER_STEP_TIMEOUT_MS);
  let tab = await findGoogleMeetCreateTab({
    runtime: params.runtime,
    nodeId,
    timeoutMs: stepTimeoutMs,
  });
  if (tab?.targetId) {
    await focusBrowserTab({
      runtime: params.runtime,
      nodeId,
      targetId: tab.targetId,
      timeoutMs: stepTimeoutMs,
    });
  } else {
    tab = readBrowserTab(
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId,
        method: "POST",
        path: "/tabs/open",
        body: { url: GOOGLE_MEET_NEW_URL },
        timeoutMs: stepTimeoutMs,
      }),
    );
  }
  const targetId = tab?.targetId;
  if (!targetId) {
    throw new Error("Browser fallback opened Google Meet but did not return a targetId.");
  }
  const notes = new Set<string>();
  let lastResult: BrowserCreateStepResult | undefined;
  let lastError: unknown;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const evaluated = await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId,
        method: "POST",
        path: "/act",
        body: {
          kind: "evaluate",
          targetId,
          fn: CREATE_MEET_FROM_BROWSER_SCRIPT,
        },
        timeoutMs: stepTimeoutMs,
      });
      const result = readBrowserCreateResult(evaluated);
      lastResult = result;
      for (const note of result.notes ?? []) {
        notes.add(note);
      }
      if (result.meetingUri) {
        return {
          source: "browser",
          nodeId,
          targetId,
          meetingUri: result.meetingUri,
          browserUrl: result.browserUrl,
          browserTitle: result.browserTitle,
          notes: [...notes],
        };
      }
      if (result.manualAction) {
        throw new GoogleMeetBrowserManualActionError({
          manualActionRequired: true,
          manualActionReason: result.manualActionReason,
          manualActionMessage: result.manualAction,
          browser: {
            nodeId,
            targetId,
            browserUrl: result.browserUrl,
            browserTitle: result.browserTitle,
            notes: [...notes],
          },
        });
      }
      await sleep(result.retryAfterMs ?? GOOGLE_MEET_BROWSER_POLL_MS);
    } catch (error) {
      lastError = error;
      if (!isBrowserNavigationInterruption(error)) {
        throw error;
      }
      await sleep(GOOGLE_MEET_BROWSER_NAVIGATION_RETRY_MS);
    }
  }
  throw new Error(
    lastResult?.manualAction ??
      `Google Meet did not return a meeting URL from the browser create flow before timeout.${
        lastError
          ? ` Last browser automation error: ${formatBrowserAutomationError(lastError)}`
          : ""
      }`,
  );
}
