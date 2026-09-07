// Nostr profile HTTP operations for the channels page: gateway REST calls for
// publishing and importing the relay profile, plus validation-error parsing.
import type { NostrProfile } from "../../api/types.ts";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";

const NOSTR_PROFILE_REQUEST_TIMEOUT_MS = 30_000;

type NostrProfileHttpResult<T> = {
  data: T | null;
  response: Response;
};

/**
 * Nostr profile routes are generic Gateway-authenticated plugin routes: they
 * validate the configured shared token/password, not paired device tokens.
 * Omit the device token whenever a saved credential exists so mutations do
 * not spend a guaranteed shared-secret failure; use it solely as a fallback
 * when it is the only credential available.
 */
export function resolveNostrMutationCandidates(
  hello: { auth?: { deviceToken?: string | null } | null } | null | undefined,
  connection: { token?: string | null; password?: string | null },
): string[] {
  const source = {
    hello,
    settings: { token: connection.token },
    password: connection.password,
  };
  const saved = resolveControlUiAuthCandidates({
    settings: source.settings,
    password: source.password,
  });
  return saved.length > 0 ? saved : resolveControlUiAuthCandidates(source);
}

async function requestNostrProfile<T>(
  url: string,
  init: Omit<RequestInit, "signal"> & {
    authCandidates?: readonly string[];
    isCurrent?: () => boolean;
  },
): Promise<NostrProfileHttpResult<T>> {
  const { authCandidates, isCurrent, ...rest } = init;
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Nostr profile request timed out after 30 seconds", "TimeoutError"),
      ),
    NOSTR_PROFILE_REQUEST_TIMEOUT_MS,
  );
  try {
    // Advance to the next saved credential only on 401: scope/origin 403s are
    // not credential failures (every candidate carries the same operator
    // scopes), and application-level statuses are returned unchanged. The
    // caller's isCurrent vetoes advancing after ownership changed (form
    // canceled, gateway disconnected, connection replaced).
    const attempts = authCandidates && authCandidates.length > 0 ? [...authCandidates] : [null];
    let lastRejected: Response | null = null;
    for (const [index, candidate] of attempts.entries()) {
      if (index > 0) {
        if (isCurrent && !isCurrent()) {
          break;
        }
      }
      const headers = {
        ...rest.headers,
        ...(candidate ? { Authorization: `Bearer ${candidate}` } : {}),
      };
      delete (headers as Record<string, string>).authorization;
      const response = await fetch(url, {
        ...rest,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        signal: controller.signal,
      });
      if (response.status === 401 && index < attempts.length - 1) {
        lastRejected = response;
        // Best-effort cancellation: stream cancel() can stay pending and must
        // not delay the next credential or the deadline.
        void response.body?.cancel().catch(() => undefined);
        continue;
      }
      let data: T | null = null;
      try {
        data = (await response.json()) as T;
      } catch (error) {
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? error;
        }
      }
      return { data, response };
    }
    if (lastRejected) {
      return { data: null, response: lastRejected };
    }
    throw new Error("unreachable nostr credential candidate state");
  } finally {
    clearTimeout(timeout);
  }
}

export function parseValidationErrors(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) {
    return {};
  }
  const errors: Record<string, string> = {};
  for (const entry of details) {
    if (typeof entry !== "string") {
      continue;
    }
    const [rawField, ...rest] = entry.split(":");
    if (!rawField || rest.length === 0) {
      continue;
    }
    const field = rawField.trim();
    const message = rest.join(":").trim();
    if (field && message) {
      errors[field] = formatUiExternalText(message);
    }
  }
  return errors;
}

function buildNostrProfileUrl(accountId: string, suffix = ""): string {
  return `/api/channels/nostr/${encodeURIComponent(accountId)}/profile${suffix}`;
}

export async function putNostrProfile(params: {
  accountId: string;
  authCandidates?: readonly string[];
  isCurrent?: () => boolean;
  values: NostrProfile;
}) {
  return await requestNostrProfile<{
    ok?: boolean;
    error?: string;
    details?: unknown;
    persisted?: boolean;
  }>(buildNostrProfileUrl(params.accountId), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params.values),
    authCandidates: params.authCandidates,
    isCurrent: params.isCurrent,
  });
}

export async function importNostrProfile(params: {
  accountId: string;
  authCandidates?: readonly string[];
  isCurrent?: () => boolean;
}) {
  return await requestNostrProfile<{
    ok?: boolean;
    error?: string;
    imported?: NostrProfile;
    merged?: NostrProfile;
    saved?: boolean;
  }>(buildNostrProfileUrl(params.accountId, "/import"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ autoMerge: true }),
    authCandidates: params.authCandidates,
    isCurrent: params.isCurrent,
  });
}
