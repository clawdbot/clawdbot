/**
 * Browser domain errors.
 *
 * Provides HTTP-mappable error classes and stable blocked-policy messages used
 * by route handlers, clients, and Gateway proxy code.
 */
/** Stable message for blocked CDP endpoint configuration. */
const BROWSER_ENDPOINT_BLOCKED_MESSAGE = "browser endpoint blocked by policy";
/** Stable message for blocked page navigation targets. */
const BROWSER_NAVIGATION_BLOCKED_MESSAGE = "browser navigation blocked by policy";

/** Stable machine-readable browser error reasons. */
export const BROWSER_ERROR_REASONS = {
  noDisplayForHeadedProfile: "no_display_for_headed_profile",
} as const;

const NO_DISPLAY_HEADLESS_SOURCES = ["request", "env", "profile", "config", "default"] as const;

export type BrowserNoDisplayErrorDetails = {
  profile: string;
  requestedHeadless: false;
  headlessSource: (typeof NO_DISPLAY_HEADLESS_SOURCES)[number];
  displayPresent: false;
};

export type BrowserNoDisplayErrorMetadata = {
  reason: typeof BROWSER_ERROR_REASONS.noDisplayForHeadedProfile;
  details: BrowserNoDisplayErrorDetails;
};

type WithNoDisplayMetadata<T> = T | (T & BrowserNoDisplayErrorMetadata);
export type BrowserErrorResponse = WithNoDisplayMetadata<{ status: number; message: string }>;
type BrowserErrorPayload = WithNoDisplayMetadata<{ error: string }>;

/** Base browser error carrying an HTTP status code. */
export class BrowserError extends Error {
  status: number;

  constructor(message: string, status = 500, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
  }
}

/**
 * Raised when a browser CDP endpoint (the cdpUrl itself) fails the
 * configured SSRF policy. Distinct from a blocked navigation target so
 * callers see "fix your browser endpoint config" rather than "fix your
 * navigation URL".
 */
export class BrowserCdpEndpointBlockedError extends BrowserError {
  constructor(options?: ErrorOptions) {
    super(BROWSER_ENDPOINT_BLOCKED_MESSAGE, 400, options);
  }
}

/** Validation failure for browser route or config input. */
export class BrowserValidationError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
  }
}

/** Raised when one tab reference matches multiple tabs. */
export class BrowserTargetAmbiguousError extends BrowserError {
  constructor(message = "ambiguous browser tab reference", options?: ErrorOptions) {
    super(message, 409, options);
  }
}

/** Raised when a requested browser tab cannot be resolved. */
export class BrowserTabNotFoundError extends BrowserError {
  constructor(inputOrMessage?: string | { input?: string }, options?: ErrorOptions) {
    const input =
      typeof inputOrMessage === "object" ? inputOrMessage.input?.trim() : inputOrMessage?.trim();
    const message = input
      ? /^\d+$/.test(input)
        ? `tab not found: browser tab "${input}" not found. Numeric values are not tab targets; use a stable tab id like "t1", a label, or a raw targetId. For positional selection, use "openclaw browser tab select ${input}".`
        : `tab not found: browser tab "${input}" not found. Use action=tabs and pass suggestedTargetId, tabId, label, or raw targetId.`
      : "tab not found";
    super(message, 404, options);
  }
}

/** Raised when a requested browser profile does not exist. */
export class BrowserProfileNotFoundError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 404, options);
  }
}

/** Raised when a browser config mutation conflicts with existing state. */
export class BrowserConflictError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 409, options);
  }
}

/** Raised when a browser profile cannot be reset by the current driver. */
export class BrowserResetUnsupportedError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
  }
}

/** Raised when a profile is configured but not currently reachable. */
export class BrowserProfileUnavailableError extends BrowserError {
  readonly metadata?: BrowserNoDisplayErrorMetadata;

  constructor(
    message: string,
    options?: ErrorOptions & { metadata?: BrowserNoDisplayErrorMetadata },
  ) {
    super(message, 409, options);
    this.metadata = options?.metadata;
  }
}

/** Raised when browser resource allocation, such as CDP ports, is exhausted. */
export class BrowserResourceExhaustedError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 507, options);
  }
}

/** Map browser-domain errors to HTTP response details. */
export function toBrowserErrorResponse(err: unknown): BrowserErrorResponse | null {
  if (err instanceof BrowserProfileUnavailableError && err.metadata) {
    return {
      status: err.status,
      message: err.message,
      ...err.metadata,
    };
  }
  if (err instanceof BrowserError) {
    return { status: err.status, message: err.message };
  }
  if (err instanceof Error && err.name === "BlockedBrowserTargetError") {
    return { status: 409, message: err.message };
  }
  if (err instanceof Error && err.name === "SsrFBlockedError") {
    // SsrFBlockedError from this point is from a navigation-target check
    // (assertBrowserNavigationAllowed / resolvePinnedHostnameWithPolicy on a
    // requested URL). CDP endpoint blocks are rethrown as
    // BrowserCdpEndpointBlockedError by assertCdpEndpointAllowed and handled
    // by the BrowserError branch above.
    return { status: 400, message: BROWSER_NAVIGATION_BLOCKED_MESSAGE };
  }
  if (err instanceof Error && err.name === "InvalidBrowserNavigationUrlError") {
    return { status: 400, message: err.message };
  }
  return null;
}

function parseNoDisplayDetails(value: unknown): BrowserNoDisplayErrorDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const details = value as Record<string, unknown>;
  if (
    typeof details.profile !== "string" ||
    details.profile.length === 0 ||
    details.requestedHeadless !== false ||
    !NO_DISPLAY_HEADLESS_SOURCES.includes(
      details.headlessSource as BrowserNoDisplayErrorDetails["headlessSource"],
    ) ||
    details.displayPresent !== false
  ) {
    return null;
  }
  return {
    profile: details.profile,
    requestedHeadless: false,
    headlessSource: details.headlessSource as BrowserNoDisplayErrorDetails["headlessSource"],
    displayPresent: false,
  };
}

/** Parse only the closed browser error metadata contract from a route payload. */
export function parseBrowserErrorPayload(value: unknown): BrowserErrorPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (typeof body.error !== "string" || body.error.length === 0) {
    return null;
  }
  if (body.reason === BROWSER_ERROR_REASONS.noDisplayForHeadedProfile) {
    const details = parseNoDisplayDetails(body.details);
    if (details) {
      return { error: body.error, reason: body.reason, details };
    }
  }
  return { error: body.error };
}
