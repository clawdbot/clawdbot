export function resolveTelegramPollVisibility(params: {
  pollAnonymous?: boolean;
  pollPublic?: boolean;
}): boolean | undefined {
  if (params.pollAnonymous && params.pollPublic) {
    throw new Error("pollAnonymous and pollPublic are mutually exclusive");
  }
  if (params.pollAnonymous) {
    return true;
  }
  if (params.pollPublic) {
    return false;
  }
  return undefined;
}
