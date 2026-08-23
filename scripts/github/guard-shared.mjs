import { setTimeout as wait } from "node:timers/promises";
import { readBoundedResponseText } from "../lib/bounded-response.mjs";

export const GITHUB_ERROR_BODY_MAX_BYTES = 64 * 1024;
export const GITHUB_RESPONSE_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const GITHUB_API_REQUEST_TIMEOUT_MS = 30_000;

const githubApiRetryStatuses = new Set([502, 503, 504]);
const githubApiRetryDelaysMs = [1_000, 2_000, 4_000];

export function guardTrustedActorCandidates({ pullRequest, event, currentHeadSha }) {
  const eventHeadSha = event?.pull_request?.head?.sha;
  const eventAfterSha = event?.after;
  const eventMatchesCurrentHead =
    Boolean(currentHeadSha) &&
    (eventHeadSha === currentHeadSha || eventAfterSha === currentHeadSha);
  if (!eventMatchesCurrentHead) {
    return [];
  }
  const candidates = [];
  const seen = new Set();
  for (const [source, login] of [["pull request author", pullRequest?.user?.login]]) {
    if (typeof login !== "string" || login.length === 0) {
      continue;
    }
    const normalizedLogin = login.toLowerCase();
    if (seen.has(normalizedLogin)) {
      continue;
    }
    seen.add(normalizedLogin);
    candidates.push({ login, source });
  }
  return candidates;
}

export function isCommentNewerThan(comment, newerThan) {
  if (!newerThan) {
    return false;
  }
  const commentTime = Date.parse(comment.created_at ?? "");
  const barrierTime = Date.parse(newerThan);
  return Number.isFinite(commentTime) && Number.isFinite(barrierTime) && commentTime > barrierTime;
}

export function guardCommentHeadSha(comment) {
  const body = comment?.body ?? "";
  const patterns = [
    /Approved SHA:\s+`([a-f0-9]{40})`/iu,
    /current head SHA\s+\(`([a-f0-9]{40})`\)/iu,
    /Current SHA:\s+`([a-f0-9]{40})`/iu,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function createIssueMutationHelpers({
  api,
  issuePath,
  owner,
  repo,
  labelNames,
  warn = console.warn,
}) {
  const ignoreUnavailableWritePermission = (action) => (error) => {
    if (error?.status === 403) {
      warn(`Skipping ${action}; token does not have write permission.`);
      return;
    }
    if (error?.status === 404 || error?.status === 422) {
      warn(`${action} is unavailable.`);
      return;
    }
    throw error;
  };
  const removeLabelIfPresent = async (label) => {
    if (!labelNames.has(label)) {
      return;
    }
    await api
      .request(`${issuePath}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE",
      })
      .catch(ignoreUnavailableWritePermission(`label "${label}" removal`));
    labelNames.delete(label);
  };
  const addLabelIfMissing = async (label) => {
    if (labelNames.has(label)) {
      return;
    }
    await api
      .request(`${issuePath}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [label] }),
      })
      .catch(ignoreUnavailableWritePermission(`label "${label}" update`));
    labelNames.add(label);
  };
  const deleteCommentIfPresent = async (comment) => {
    if (!comment) {
      return;
    }
    await api
      .request(`/repos/${owner}/${repo}/issues/comments/${comment.id}`, {
        method: "DELETE",
      })
      .catch(ignoreUnavailableWritePermission("comment deletion"));
  };
  const upsertComment = async (comment, body) => {
    if (comment) {
      return await api
        .request(`/repos/${owner}/${repo}/issues/comments/${comment.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        })
        .catch(ignoreUnavailableWritePermission("comment update"));
    }
    return await api
      .request(`${issuePath}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      })
      .catch(ignoreUnavailableWritePermission("comment creation"));
  };
  return { removeLabelIfPresent, addLabelIfMissing, deleteCommentIfPresent, upsertComment };
}

export function createGuardApproverChecks({
  api,
  owner,
  repo,
  securityTeamSlug,
  explicitSecurityApprovers,
  warn = console.warn,
}) {
  const membershipCache = new Map();
  const permissionCache = new Map();
  const isSecurityMember = async (login) => {
    const normalizedLogin = login.toLowerCase();
    if (explicitSecurityApprovers.has(normalizedLogin)) {
      return true;
    }
    if (membershipCache.has(normalizedLogin)) {
      return membershipCache.get(normalizedLogin);
    }
    try {
      const membership = await api.request(
        `/orgs/${owner}/teams/${securityTeamSlug}/memberships/${encodeURIComponent(login)}`,
      );
      const allowed = membership?.state === "active";
      membershipCache.set(normalizedLogin, allowed);
      return allowed;
    } catch (error) {
      if (error?.status !== 404) {
        warn(`Could not verify ${login} against ${securityTeamSlug}: ${error.message}`);
      }
      membershipCache.set(normalizedLogin, false);
      return false;
    }
  };
  const isRepositoryAdmin = async (login) => {
    const normalizedLogin = login.toLowerCase();
    if (permissionCache.has(normalizedLogin)) {
      return permissionCache.get(normalizedLogin);
    }
    try {
      const result = await api.request(
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      const allowed = result?.permission === "admin";
      permissionCache.set(normalizedLogin, allowed);
      return allowed;
    } catch (error) {
      if (error?.status !== 404) {
        warn(`Could not verify repository permission for ${login}: ${error.message}`);
      }
      permissionCache.set(normalizedLogin, false);
      return false;
    }
  };
  return { isSecurityMember, isRepositoryAdmin };
}

function githubErrorBodyTooLarge(maxBytes) {
  return new Error(`GitHub error response body exceeded ${maxBytes} bytes`);
}

function githubResponseBodyTooLarge(maxBytes) {
  return new Error(`GitHub response body exceeded ${maxBytes} bytes`);
}

export async function readBoundedGitHubErrorText(
  response,
  maxBytes = GITHUB_ERROR_BODY_MAX_BYTES,
  options = {},
) {
  return await readBoundedResponseText(response, "GitHub error", maxBytes, {
    createTooLargeError: () => githubErrorBodyTooLarge(maxBytes),
    ...options,
  });
}

export async function readBoundedGitHubJson(
  response,
  maxBytes = GITHUB_RESPONSE_BODY_MAX_BYTES,
  options = {},
) {
  const text = await readBoundedResponseText(response, "GitHub", maxBytes, {
    createTooLargeError: () => githubResponseBodyTooLarge(maxBytes),
    ...options,
  });
  return JSON.parse(text);
}

function timeoutError(path, method, timeoutMs) {
  return new Error(`GitHub API ${method} ${path} exceeded timeout ${timeoutMs}ms`);
}

function combineAbortSignals(signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  return AbortSignal.any(activeSignals);
}

export function createGitHubApi(token, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GITHUB_API_REQUEST_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? githubApiRetryDelaysMs;
  const responseMaxBodyBytes = options.responseMaxBodyBytes ?? GITHUB_RESPONSE_BODY_MAX_BYTES;
  const baseHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": options.userAgent,
    "x-github-api-version": "2022-11-28",
  };
  const request = async (path, requestOptions = {}) => {
    const method = (requestOptions.method ?? "GET").toUpperCase();
    const timeoutController = new AbortController();
    const requestSignal = combineAbortSignals([requestOptions.signal, timeoutController.signal]);
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timeoutController.abort();
        reject(timeoutError(path, method, timeoutMs));
      }, timeoutMs);
      timeout.unref?.();
    });
    const operationPromise = (async () => {
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetchImpl(`https://api.github.com${path}`, {
          ...requestOptions,
          signal: requestSignal,
          headers: { ...baseHeaders, ...requestOptions.headers },
        });
        if (response.status === 204) {
          return null;
        }
        if (!response.ok) {
          if (
            (method === "GET" || method === "HEAD") &&
            githubApiRetryStatuses.has(response.status) &&
            attempt < retryDelaysMs.length
          ) {
            await response.body?.cancel().catch(() => {});
            await wait(retryDelaysMs[attempt], undefined, { signal: requestSignal });
            continue;
          }
          let errorText;
          try {
            errorText = await readBoundedGitHubErrorText(response, GITHUB_ERROR_BODY_MAX_BYTES, {
              signal: timeoutController.signal,
              timeoutPromise,
            });
          } catch (bodyError) {
            errorText = bodyError instanceof Error ? bodyError.message : String(bodyError);
          }
          const error = new Error(`${response.status} ${response.statusText}: ${errorText}`);
          error.status = response.status;
          throw error;
        }
        return await readBoundedGitHubJson(response, responseMaxBodyBytes, {
          signal: timeoutController.signal,
          timeoutPromise,
        });
      }
    })();
    operationPromise.catch(() => {});
    try {
      return await Promise.race([operationPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
  };
  return {
    request,
    paginate: async (path) => {
      const items = [];
      for (let page = 1; ; page += 1) {
        const separator = path.includes("?") ? "&" : "?";
        const pageItems = await request(`${path}${separator}per_page=100&page=${page}`);
        items.push(...pageItems);
        if (pageItems.length < 100) {
          return items;
        }
      }
    },
  };
}
