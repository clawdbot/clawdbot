// Provider OAuth runtime helpers expose shared browser/OAuth flows for provider plugins.
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "../../packages/normalization-core/src/number-coercion.js";
import type { Model } from "../llm/types.js";

// Static OpenClaw lobster mascot; keep shapes in sync with ui/public/favicon.svg.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" aria-hidden="true"><defs><linearGradient id="lobster-gradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path fill="url(#lobster-gradient)" d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"/><path fill="url(#lobster-gradient)" d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"/><path fill="url(#lobster-gradient)" d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"/><path stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" d="M45 15 Q35 5 30 8"/><path stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" d="M75 15 Q85 5 90 8"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2.5" fill="#00e5cc"/><circle cx="76" cy="34" r="2.5" fill="#00e5cc"/></svg>`;

/** Normalized OAuth credential bundle persisted by provider auth profiles. */
export type OAuthCredentials = {
  /** Refresh token or provider-equivalent long-lived credential. */
  refresh: string;
  /** Access token or provider-equivalent bearer credential. */
  access: string;
  /** Absolute epoch milliseconds when the access token should be considered expired. */
  expires: number;
  [key: string]: unknown;
};

/** Stable provider id used by OAuth credential and config routing. */
export type OAuthProviderId = string;

/** @deprecated Use OAuthProviderId instead. */
export type OAuthProvider = OAuthProviderId;

/** Manual input prompt shown during OAuth login flows. */
export type OAuthPrompt = {
  /** Prompt text shown to the operator. */
  message: string;
  /** Optional placeholder for manual text entry. */
  placeholder?: string;
  /** Whether empty input should be accepted instead of reprompting. */
  allowEmpty?: boolean;
};

/** Parsed OAuth callback/code input accepted by manual and callback-server flows. */
export type OAuthAuthorizationInput = {
  /** Authorization code parsed from a callback URL, query string, or pasted code. */
  code?: string;
  /** Optional OAuth state parsed from callback URL, query string, or `code#state` input. */
  state?: string;
};

/** Authorization URL and optional instructions shown before OAuth completion. */
export type OAuthAuthInfo = {
  /** Provider authorization URL shown to the user. */
  url: string;
  /** Optional provider-specific instruction text for manual flows. */
  instructions?: string;
};

/** One selectable OAuth login option. */
export type OAuthSelectOption = {
  /** Stable option id returned when the operator selects this entry. */
  id: string;
  /** Human-readable option label shown in the selector. */
  label: string;
};

/** Selector prompt used when a provider offers multiple OAuth login choices. */
export type OAuthSelectPrompt = {
  /** Prompt text shown above the selectable options. */
  message: string;
  /** Options available for the operator to choose from. */
  options: OAuthSelectOption[];
};

/** UI/runtime callbacks used by provider OAuth login implementations. */
export interface OAuthLoginCallbacks {
  /** Emits authorization URL/instructions to the UI before waiting for completion. */
  onAuth: (info: OAuthAuthInfo) => void;
  /** Prompts for manual input such as pasted callback URLs or authorization codes. */
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  /** Reports human-readable login progress without exposing secrets. */
  onProgress?: (message: string) => void;
  /** Optional direct manual-code entry hook used when callback-server flows cannot complete. */
  onManualCodeInput?: () => Promise<string>;
  /** Show an interactive selector and return the selected option id, or undefined on cancel. */
  onSelect?: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
  /** Cancels pending OAuth waits and prompts when aborted. */
  signal?: AbortSignal;
}

/** Provider OAuth contract implemented by provider plugins. */
export interface OAuthProviderInterface {
  /** Stable provider id used for credential and config routing. */
  readonly id: OAuthProviderId;
  /** Human-readable provider name shown in login flows. */
  readonly name: string;

  /** Run the login flow and return credentials to persist. */
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;

  /** Whether login uses a local callback server and supports manual code input. */
  usesCallbackServer?: boolean;

  /** Refresh expired credentials and return updated credentials to persist. */
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;

  /** Convert credentials to an API key string for the provider. */
  getApiKey(credentials: OAuthCredentials): string;

  /** Optionally adjust models for this provider, such as updating baseUrl. */
  modifyModels?(models: Model[], credentials: OAuthCredentials): Model[];
}

/** @deprecated Use OAuthProviderInterface instead. */
export interface OAuthProviderInfo {
  /** Stable provider id used for credential and config routing. */
  id: OAuthProviderId;
  /** Human-readable provider name shown in login flows. */
  name: string;
  /** Whether this provider can currently start OAuth login. */
  available: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderOAuthPage(options: {
  title: string;
  heading: string;
  message: string;
  details?: string;
}): string {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

/**
 * Renders the local OAuth callback success page after provider authentication completes.
 */
export function oauthSuccessHtml(
  /** Success message rendered in the local OAuth completion page. */
  message: string,
): string {
  return renderOAuthPage({
    title: "Authentication successful",
    heading: "Authentication successful",
    message,
  });
}

/**
 * Renders the local OAuth callback error page without exposing raw credential material.
 */
export function oauthErrorHtml(
  /** Error message rendered in the local OAuth completion page. */
  message: string,
  /** Optional provider-specific error details rendered below the message. */
  details?: string,
): string {
  return renderOAuthPage({
    title: "Authentication failed",
    heading: "Authentication failed",
    message,
    details,
  });
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/[=]/g, "");
}

/** Generates an OAuth PKCE verifier and SHA-256 challenge using base64url encoding. */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));

  return { verifier, challenge };
}

/** Generates a random base64url OAuth state value for CSRF protection. */
export function generateOAuthState(): string {
  const stateBytes = new Uint8Array(32);
  crypto.getRandomValues(stateBytes);
  return base64urlEncode(stateBytes);
}

/**
 * Parses callback URLs, raw query strings, `code#state`, or plain pasted codes.
 * Empty input returns an empty object so callers can keep prompting.
 */
export function parseOAuthAuthorizationInput(
  /** Raw callback URL, query string, `code#state`, or pasted code. */
  input: string,
): OAuthAuthorizationInput {
  const value = input.trim();
  if (!value) {
    return {};
  }

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Plain pasted code or query-string input.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

/** Converts provider `expires_in` seconds into safe positive milliseconds. */
export function resolveOAuthTokenLifetimeMs(
  /** Provider `expires_in` value in seconds. */
  value: unknown,
): number | undefined {
  return positiveSecondsToSafeMilliseconds(value);
}

/** Resolves provider token lifetime into an absolute expiry timestamp with optional refresh skew. */
export function resolveOAuthTokenExpiresAt(
  /** Provider `expires_in` value in seconds. */
  value: unknown,
  options: {
    /** Current timestamp override for deterministic expiry calculations. */
    nowMs?: number;
    /** Milliseconds to subtract so refresh happens before provider expiry. */
    refreshSkewMs?: number;
  } = {},
): number | undefined {
  const lifetimeMs = resolveOAuthTokenLifetimeMs(value);
  return lifetimeMs === undefined
    ? undefined
    : resolveExpiresAtMsFromDurationMs(lifetimeMs, {
        nowMs: options.nowMs,
        bufferMs: options.refreshSkewMs,
      });
}

/**
 * Creates the shared cancellation error used by abortable OAuth login flows.
 */
export function createOAuthLoginCancelledError(): Error {
  return new Error("Login cancelled");
}

/** Throws the shared OAuth cancellation error when a login signal is already aborted. */
export function throwIfOAuthLoginAborted(
  /** Abort signal attached to the OAuth login flow. */
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    throw createOAuthLoginCancelledError();
  }
}

/** Races a pending OAuth login step against the login abort signal and normalizes rejections. */
export function withOAuthLoginAbort<T>(
  /** Pending OAuth login operation to race against abort. */
  promise: Promise<T>,
  /** Abort signal attached to the OAuth login flow. */
  signal?: AbortSignal,
  /** Optional cleanup hook called when the login is aborted. */
  onAbort?: () => void,
): Promise<T> {
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      onAbort?.();
      reject(createOAuthLoginCancelledError());
    };

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        // The login step won the race; remove abort listeners so long-lived prompts do not leak.
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        // Preserve Error rejections but wrap non-Error provider/prompt values for lint-safe callers.
        cleanup();
        reject(toErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

/** Combines a caller abort signal with a bounded timeout signal for OAuth HTTP requests. */
export function buildOAuthRequestSignal(options: {
  /** Optional caller-provided signal to combine with the timeout signal. */
  signal?: AbortSignal;
  /** Request timeout in milliseconds before the generated signal aborts. */
  timeoutMs: number;
}): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(resolveTimerTimeoutMs(options.timeoutMs, 0, 0));
  if (!options.signal) {
    return timeoutSignal;
  }
  return AbortSignal.any([options.signal, timeoutSignal]);
}
