import { z } from "zod";
import { GitHubIdentityError, prepareGitHubReadIdentity } from "../agents/github-tool-identity.js";
import { BoardValidationError } from "../boards/board-layout.js";
import { resolveGitHubActionsRequest } from "../boards/github-actions-capability.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { BoardCapabilityAuthority } from "./board-host-tools.js";
import { BoardGatewayUnavailableError } from "./board-view-ticket.js";
import {
  ControlUiGitHubError,
  fetchGitHubApi,
  readGitHubJsonResponse,
} from "./control-ui-github-api.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 32;
const MAX_CONCURRENT_READS = 32;
// Thirty workflow runs include large repository objects before projection.
const ACTIONS_MAX_RESPONSE_BYTES = 1024 * 1024;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().max(256);
const timestamp = z.string().max(40).datetime({ offset: true });
const runsSchema = z.object({
  total_count: integer,
  workflow_runs: z
    .array(
      z.object({
        id: integer,
        name: shortText.nullable(),
        display_title: z.string().max(1024),
        head_branch: shortText.nullable(),
        status: shortText.nullable(),
        conclusion: shortText.nullable(),
        html_url: z.string().max(2048).url(),
        run_started_at: timestamp.nullable(),
        created_at: timestamp,
        updated_at: timestamp,
        event: shortText,
        workflow_id: integer,
        run_attempt: integer,
      }),
    )
    .max(30),
});
type ActionsResult = z.infer<typeof runsSchema>;
type ActionsCache = {
  active: number;
  values: Map<string, { value: ActionsResult; expiresAt: number }>;
  pending: Map<string, Promise<ActionsResult>>;
};
const gatewayCaches = new WeakMap<GatewayRequestContext, ActionsCache>();

function actionsFailure(error: unknown): Error {
  if (
    error instanceof BoardValidationError ||
    error instanceof BoardGatewayUnavailableError ||
    error instanceof GitHubIdentityError
  ) {
    return error;
  }
  if (error instanceof ControlUiGitHubError) {
    if (error.statusCode === 429) {
      return new Error("GitHub Actions is rate limited; wait and retry.");
    }
    if (error.statusCode === 401) {
      return new Error(
        "GitHub Actions authentication expired; reconnect the agent's GitHub identity in Settings.",
      );
    }
    if (error.statusCode === 403 || error.statusCode === 404) {
      return new Error(
        "GitHub Actions access denied or repository unavailable; check the repository and the selected agent identity's Actions read permission.",
      );
    }
  }
  // Never expose upstream bodies, transport errors, or credential subprocess diagnostics.
  return new Error(
    "GitHub Actions request failed or exceeded its response limit; retry with a smaller perPage or check GitHub availability.",
  );
}

/** Pinning and reads share the same source-config scrub, refresh, and current credential check. */
export async function prepareBoardGitHubIdentity(
  context: GatewayRequestContext,
  authority: Pick<BoardCapabilityAuthority, "boardSession" | "assertActive">,
) {
  try {
    const config = context.getRuntimeConfig();
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId: authority.boardSession.agentId,
      getCurrentConfig: () => context.getRuntimeConfig(),
      assertActive: authority.assertActive,
      refresh: () => requestCurrentGitHubOAuthRefresh(authority.boardSession.agentId),
    });
    await identity.revalidate();
    return identity;
  } catch (error) {
    if (
      error instanceof GitHubIdentityError ||
      error instanceof BoardValidationError ||
      error instanceof BoardGatewayUnavailableError
    ) {
      throw error;
    }
    throw new GitHubIdentityError("unverified");
  }
}

export async function readBoardGitHubActions(
  params: Record<string, unknown>,
  context: GatewayRequestContext,
  authority: BoardCapabilityAuthority,
): Promise<ActionsResult> {
  const request = resolveGitHubActionsRequest(params);
  authority.assertActive();
  const cache: ActionsCache = gatewayCaches.get(context) ?? {
    active: 0,
    values: new Map(),
    pending: new Map(),
  };
  gatewayCaches.set(context, cache);
  if (cache.active >= MAX_CONCURRENT_READS) {
    throw new Error("GitHub Actions reads are busy; retry shortly.");
  }
  cache.active += 1;
  try {
    const identity = await prepareBoardGitHubIdentity(context, authority);
    identity.assertSelected();
    const key = JSON.stringify([authority.boardSession, identity.cacheScope, request.url]);
    const cached = cache.values.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return structuredClone(cached.value);
    }
    cache.values.delete(key);
    // Creation is synchronous, so the checked caller admits the fetch. Shared transport
    // must not inherit that widget's lifetime; every caller gates delivery below.
    const result = await getOrCreatePromise(
      cache.pending,
      key,
      async () => {
        const response = await fetchGitHubApi(request.url, fetch, identity.token, async () => {
          // A redirect is a new target, not authority to read another repository or operation.
          throw new BoardValidationError(
            "invalid_operation",
            "GitHub Actions redirected the request; verify the repository/workflow, update the widget grant if needed, and retry.",
          );
        });
        const raw = await readGitHubJsonResponse(response, ACTIONS_MAX_RESPONSE_BYTES);
        const parsed = runsSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.workflow_runs.length > request.perPage ||
          JSON.stringify(parsed.data).includes(identity.token)
        ) {
          throw new Error("Invalid Actions response");
        }
        for (const run of parsed.data.workflow_runs) {
          const url = new URL(run.html_url);
          if (
            url.origin !== "https://github.com" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname.toLowerCase() !== `/${request.repository}/actions/runs/${run.id}`
          ) {
            throw new Error("Invalid Actions run URL");
          }
        }
        // Internal, credential-scoped cache population is not delivery. No widget owns
        // this transport result; every caller must validate its own authority below.
        cache.values.set(key, { value: parsed.data, expiresAt: Date.now() + CACHE_TTL_MS });
        pruneMapToMaxSize(cache.values, CACHE_LIMIT);
        return parsed.data;
      },
      { evictOnSettled: true },
    );
    await identity.revalidate();
    identity.assertSelected();
    return structuredClone(result);
  } catch (error) {
    throw actionsFailure(error);
  } finally {
    cache.active -= 1;
  }
}
