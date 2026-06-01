import {
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "../../packages/normalization-core/src/number-coercion.js";
import type { Model } from "../llm/types.js";

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"/><path fill="#fff" d="M517.36 400 H634.72 V634.72 H517.36 Z"/></svg>`;

export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
};

export type OAuthProviderId = string;

/** @deprecated Use OAuthProviderId instead. */
export type OAuthProvider = OAuthProviderId;

export type OAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type OAuthAuthorizationInput = {
  code?: string;
  state?: string;
};

export type OAuthAuthInfo = {
  url: string;
  instructions?: string;
};

export type OAuthSelectOption = {
  id: string;
  label: string;
};

export type OAuthSelectPrompt = {
  message: string;
  options: OAuthSelectOption[];
};

export interface OAuthLoginCallbacks {
  onAuth: (info: OAuthAuthInfo) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  /** Show an interactive selector and return the selected option id, or undefined on cancel. */
  onSelect?: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
  signal?: AbortSignal;
}

export interface OAuthProviderInterface {
  readonly id: OAuthProviderId;
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
  id: OAuthProviderId;
  name: string;
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

export function oauthSuccessHtml(message: string): string {
  return renderOAuthPage({
    title: "Authentication successful",
    heading: "Authentication successful",
    message,
  });
}

export function oauthErrorHtml(message: string, details?: string): string {
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

export function generateOAuthState(): string {
  const stateBytes = new Uint8Array(32);
  crypto.getRandomValues(stateBytes);
  return base64urlEncode(stateBytes);
}

export function parseOAuthAuthorizationInput(input: string): OAuthAuthorizationInput {
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

export function resolveOAuthTokenLifetimeMs(value: unknown): number | undefined {
  return positiveSecondsToSafeMilliseconds(value);
}

export function resolveOAuthTokenExpiresAt(
  value: unknown,
  options: { nowMs?: number; refreshSkewMs?: number } = {},
): number | undefined {
  const lifetimeMs = resolveOAuthTokenLifetimeMs(value);
  return lifetimeMs === undefined
    ? undefined
    : resolveExpiresAtMsFromDurationMs(lifetimeMs, {
        nowMs: options.nowMs,
        bufferMs: options.refreshSkewMs,
      });
}

export function createOAuthLoginCancelledError(): Error {
  return new Error("Login cancelled");
}

export function throwIfOAuthLoginAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createOAuthLoginCancelledError();
  }
}

export function withOAuthLoginAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
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
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(toLintErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

export function buildOAuthRequestSignal(options: {
  signal?: AbortSignal;
  timeoutMs: number;
}): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(resolveTimerTimeoutMs(options.timeoutMs, 0, 0));
  if (!options.signal) {
    return timeoutSignal;
  }
  return AbortSignal.any([options.signal, timeoutSignal]);
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
