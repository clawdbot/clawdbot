// Tlon plugin module implements channel ops behavior.
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { UrbitHttpError } from "./errors.js";
import { urbitFetch } from "./fetch.js";

type UrbitChannelDeps = {
  baseUrl: string;
  cookie: string;
  ship: string;
  channelId: string;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

async function putUrbitChannel(
  deps: UrbitChannelDeps,
  params: { body: unknown; auditContext: string },
) {
  return await urbitFetch({
    baseUrl: deps.baseUrl,
    path: `/~/channel/${deps.channelId}`,
    init: {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: deps.cookie,
      },
      body: JSON.stringify(params.body),
    },
    ssrfPolicy: deps.ssrfPolicy,
    lookupFn: deps.lookupFn,
    fetchImpl: deps.fetchImpl,
    timeoutMs: 30_000,
    auditContext: params.auditContext,
  });
}

const TLON_ERROR_BODY_LIMIT_BYTES = 16 * 1024;

export async function pokeUrbitChannel(
  deps: UrbitChannelDeps,
  params: { app: string; mark: string; json: unknown; auditContext: string },
): Promise<number> {
  const pokeId = Date.now();
  const pokeData = {
    id: pokeId,
    action: "poke",
    ship: deps.ship,
    app: params.app,
    mark: params.mark,
    json: params.json,
  };

  const { response, release } = await putUrbitChannel(deps, {
    body: [pokeData],
    auditContext: params.auditContext,
  });

  try {
    if (!response.ok && response.status !== 204) {
      const errorText = await readResponseTextLimited(response, TLON_ERROR_BODY_LIMIT_BYTES).catch(
        () => "",
      );
      throw new UrbitHttpError({
        operation: "Poke",
        status: response.status,
        bodyText: errorText || undefined,
      });
    }
    return pokeId;
  } finally {
    await release();
  }
}

export async function scryUrbitPath(
  deps: Pick<UrbitChannelDeps, "baseUrl" | "cookie" | "ssrfPolicy" | "lookupFn" | "fetchImpl">,
  params: { path: string; auditContext: string },
): Promise<unknown> {
  const scryPath = `/~/scry${params.path}`;
  const { response, release } = await urbitFetch({
    baseUrl: deps.baseUrl,
    path: scryPath,
    init: {
      method: "GET",
      headers: { Cookie: deps.cookie },
    },
    ssrfPolicy: deps.ssrfPolicy,
    lookupFn: deps.lookupFn,
    fetchImpl: deps.fetchImpl,
    timeoutMs: 30_000,
    auditContext: params.auditContext,
  });

  try {
    if (!response.ok) {
      throw new UrbitHttpError({
        operation: `Scry for path ${params.path}`,
        status: response.status,
      });
    }
    // Successful scry bodies come from a remote Urbit and have no protocol size bound.
    // Keep the shared JSON ceiling while retaining the path needed to identify the endpoint.
    return await readProviderJsonResponse(response, `Tlon scry response for path ${params.path}`);
  } finally {
    await release();
  }
}

async function createUrbitChannel(
  deps: UrbitChannelDeps,
  params: { body: unknown; auditContext: string },
): Promise<void> {
  const { response, release } = await putUrbitChannel(deps, params);

  try {
    if (!response.ok && response.status !== 204) {
      throw new UrbitHttpError({ operation: "Channel creation", status: response.status });
    }
  } finally {
    await release();
  }
}

async function wakeUrbitChannel(deps: UrbitChannelDeps): Promise<void> {
  const { response, release } = await putUrbitChannel(deps, {
    body: [
      {
        id: Date.now(),
        action: "poke",
        ship: deps.ship,
        app: "hood",
        mark: "helm-hi",
        json: "Opening API channel",
      },
    ],
    auditContext: "tlon-urbit-channel-wake",
  });

  try {
    if (!response.ok && response.status !== 204) {
      throw new UrbitHttpError({ operation: "Channel activation", status: response.status });
    }
  } finally {
    await release();
  }
}

export async function ensureUrbitChannelOpen(
  deps: UrbitChannelDeps,
  params: { createBody: unknown; createAuditContext: string },
): Promise<void> {
  await createUrbitChannel(deps, {
    body: params.createBody,
    auditContext: params.createAuditContext,
  });
  await wakeUrbitChannel(deps);
}
