import { FailoverError } from "../failover/error.js";

/** Keeps missing explicit credentials actionable across model and auth preparation. */
export function createSelectedAuthProfileUnavailableError(params: {
  profileId: string;
  provider: string;
  modelId: string;
}): FailoverError {
  return new FailoverError(`Selected auth profile "${params.profileId}" is unavailable.`, {
    reason: "auth",
    status: 401,
    code: "selected_auth_profile_unavailable",
    provider: params.provider,
    model: params.modelId,
    profileId: params.profileId,
  });
}
