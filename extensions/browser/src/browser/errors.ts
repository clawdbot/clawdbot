export const BROWSER_ENDPOINT_BLOCKED_MESSAGE = "browser endpoint blocked by policy";
export const BROWSER_NAVIGATION_BLOCKED_MESSAGE = "browser navigation blocked by policy";

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

export class BrowserValidationError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
  }
}

export class BrowserConfigurationError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
  }
}

export class BrowserTargetAmbiguousError extends BrowserError {
  constructor(message = "ambiguous target id prefix", options?: ErrorOptions) {
    super(message, 409, options);
  }
}

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

export class BrowserProfileNotFoundError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 404, options);
  }
}

export class BrowserConflictError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 409, options);
  }
}

export class BrowserResetUnsupportedError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
  }
}

export class BrowserProfileUnavailableError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 409, options);
  }
}

export class BrowserResourceExhaustedError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 507, options);
  }
}

export function toBrowserErrorResponse(err: unknown): {
  status: number;
  message: string;
} | null {
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
