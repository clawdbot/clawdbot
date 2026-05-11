import type { WebClient } from "@slack/web-api";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSlackWebClient } from "./client.js";
import { formatSlackError } from "./errors.js";

export type SlackScopesResult = {
  ok: boolean;
  scopes?: string[];
  source?: string;
  error?: string;
};

type SlackScopesSource = "auth.scopes" | "apps.permissions.info";
type SlackScopesMethod = "auth.test" | SlackScopesSource;

function collectScopes(value: unknown, into: string[]) {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) {
        into.push(entry.trim());
      }
    }
    return;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) {
      return;
    }
    const parts = raw.split(/[,\s]+/).map((part) => part.trim());
    for (const part of parts) {
      if (part) {
        into.push(part);
      }
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry) || typeof entry === "string") {
      collectScopes(entry, into);
    }
  }
}

function normalizeScopes(scopes: string[]) {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean))).toSorted();
}

function extractScopes(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const scopes: string[] = [];
  collectScopes(payload.scopes, scopes);
  collectScopes(payload.scope, scopes);
  if (isRecord(payload.response_metadata)) {
    collectScopes(payload.response_metadata.scopes, scopes);
  }
  if (isRecord(payload.info)) {
    collectScopes(payload.info.scopes, scopes);
    collectScopes(payload.info.scope, scopes);
    collectScopes((payload.info as { user_scopes?: unknown }).user_scopes, scopes);
    collectScopes((payload.info as { bot_scopes?: unknown }).bot_scopes, scopes);
  }
  return normalizeScopes(scopes);
}

async function callSlack(
  client: WebClient,
  method: SlackScopesMethod,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await client.apiCall(method);
    return isRecord(result) ? result : null;
  } catch (err) {
    return {
      ok: false,
      error: formatSlackError(err),
    };
  }
}

export async function fetchSlackScopes(
  token: string,
  timeoutMs: number,
): Promise<SlackScopesResult> {
  const client = createSlackWebClient(token, { timeout: timeoutMs });
  const attempts: SlackScopesMethod[] = ["auth.test", "auth.scopes", "apps.permissions.info"];
  const errors: string[] = [];

  for (const method of attempts) {
    const result = await callSlack(client, method);
    const scopes = extractScopes(result);
    if (scopes.length > 0) {
      return { ok: true, scopes, source: method };
    }
    const error = isRecord(result) ? normalizeOptionalString(result.error) : undefined;
    if (error) {
      errors.push(`${method}: ${error}`);
    }
  }

  return {
    ok: false,
    error: errors.length > 0 ? errors.join(" | ") : "no scopes returned",
  };
}
