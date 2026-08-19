import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import {
  ControlUiGitHubError,
  GITHUB_API_ORIGIN,
  fetchGitHubJson,
  optionalNumber,
  readOptionalGitHubString,
} from "./control-ui-github-api.js";

type ResolvedGitHubUserIdentity = { accountId: number; login: string };

export async function resolveGitHubUserIdentity(
  username: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedGitHubUserIdentity> {
  const requestedLogin = normalizeGitHubLogin(username);
  if (!requestedLogin) {
    throw new TypeError("GitHub username is invalid");
  }
  let payload: unknown;
  try {
    payload = await fetchGitHubJson(
      `${GITHUB_API_ORIGIN}/users/${encodeURIComponent(requestedLogin)}`,
      fetchImpl,
      undefined,
    );
  } catch (error) {
    if (error instanceof ControlUiGitHubError) {
      throw error;
    }
    throw new ControlUiGitHubError(502, "GitHub user lookup failed");
  }
  if (!isRecord(payload)) {
    throw new ControlUiGitHubError(502, "GitHub user response was not an object");
  }
  const accountId = optionalNumber(payload, "id");
  const login = normalizeGitHubLogin(readOptionalGitHubString(payload, "login") ?? "");
  if (
    typeof accountId !== "number" ||
    !Number.isSafeInteger(accountId) ||
    accountId <= 0 ||
    !login
  ) {
    throw new ControlUiGitHubError(502, "GitHub user response omitted a valid id or login");
  }
  return { accountId, login };
}
