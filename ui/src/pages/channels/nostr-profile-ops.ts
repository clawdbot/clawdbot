import type { GatewayBrowserClient } from "../../api/gateway.ts";
// Nostr profile HTTP operations for the channels page: gateway REST calls for
// publishing and importing the relay profile, plus validation-error parsing.
import type { NostrProfile } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { NostrProfileFormState } from "./view.nostr-profile-form.ts";

export type NostrOperation = {
  generation: number;
  gateway: ApplicationContext["gateway"];
  channels: ApplicationContext["channels"];
  client: GatewayBrowserClient;
  abortController: AbortController;
  formAccountId: string | null;
  accountId: string;
  headers: Record<string, string>;
};

export class NostrOperationController {
  private current: AbortController | null = null;

  abort() {
    this.current?.abort();
    this.current = null;
  }

  start(): AbortController {
    this.abort();
    this.current = new AbortController();
    return this.current;
  }

  finish(operation: NostrOperation) {
    if (this.current === operation.abortController) {
      this.current = null;
    }
  }
}

export function resolveNostrAccountId(
  channels: ApplicationContext["channels"],
  profileAccountId: string | null,
): string {
  const accounts = channels.state.channelsSnapshot?.channelAccounts?.nostr ?? [];
  return profileAccountId ?? accounts[0]?.accountId ?? "default";
}

export function mergeNostrProfileDraft(
  merged: NostrProfile,
  values: NostrProfile,
  original: NostrProfile,
  importedBaseline: Partial<NostrProfile> = {},
): NostrProfile {
  const draft = { ...values, ...merged };
  for (const field of Object.keys(values) as Array<keyof NostrProfile>) {
    const baseline = Object.hasOwn(importedBaseline, field)
      ? importedBaseline[field]
      : original[field];
    if (values[field] !== baseline) {
      draft[field] = values[field];
    }
  }
  return draft;
}

export type NostrProfileImportResponse = {
  imported?: NostrProfile;
  merged?: NostrProfile;
};

export function mergeNostrProfileImportDraft(
  data: NostrProfileImportResponse,
  form: Pick<NostrProfileFormState, "values" | "original" | "importedBaseline">,
) {
  const imported = data.merged ?? data.imported;
  return {
    values: imported
      ? mergeNostrProfileDraft(imported, form.values, form.original, form.importedBaseline)
      : form.values,
    importedBaseline: imported ? { ...form.importedBaseline, ...imported } : form.importedBaseline,
  };
}

export function isCurrentNostrOperation(
  operation: NostrOperation,
  connected: boolean,
  generation: number,
  formAccountId: string | null,
  context: ApplicationContext,
): boolean {
  return (
    connected &&
    generation === operation.generation &&
    formAccountId === operation.formAccountId &&
    context.gateway === operation.gateway &&
    context.channels === operation.channels &&
    operation.gateway.snapshot.client === operation.client &&
    operation.gateway.snapshot.phase === "connected"
  );
}

const NOSTR_PROFILE_REQUEST_TIMEOUT_MS = 30_000;

type NostrProfileHttpResult<T> = {
  data: T | null;
  response: Response;
};

async function requestNostrProfile<T>(
  url: string,
  init: RequestInit,
): Promise<NostrProfileHttpResult<T>> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) {
    abortFromCaller();
  } else {
    init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Nostr profile request timed out after 30 seconds", "TimeoutError"),
      ),
    NOSTR_PROFILE_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? error;
      }
    }
    return { data, response };
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
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
      errors[field] = message;
    }
  }
  return errors;
}

function buildNostrProfileUrl(accountId: string, suffix = ""): string {
  return `/api/channels/nostr/${encodeURIComponent(accountId)}/profile${suffix}`;
}

export async function putNostrProfile(params: {
  accountId: string;
  headers: Record<string, string>;
  values: NostrProfile;
  signal?: AbortSignal;
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
      ...params.headers,
    },
    body: JSON.stringify(params.values),
    signal: params.signal,
  });
}

export async function importNostrProfile(params: {
  accountId: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}) {
  return await requestNostrProfile<
    NostrProfileImportResponse & {
      ok?: boolean;
      error?: string;
      saved?: boolean;
    }
  >(buildNostrProfileUrl(params.accountId, "/import"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify({ autoMerge: false }),
    signal: params.signal,
  });
}
