// Conservative defaults for self-hosted providers when the model catalog cannot
// supply pricing or token limits.
export const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128000;
export const SELF_HOSTED_DEFAULT_MAX_TOKENS = 8192;
export const SELF_HOSTED_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
