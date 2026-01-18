export interface SlackChallengeEvent {
  type: string;
  challenge: string;
  token: string;
}

export const isUrlVerification = (
  payload: unknown,
): payload is SlackChallengeEvent => {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const candidate = payload as Record<string, unknown>;

  return (
    candidate.type === "url_verification" &&
    typeof candidate.challenge === "string" &&
    typeof candidate.token === "string"
  );
};

export const handleUrlVerification = (payload: SlackChallengeEvent): string => {
  return payload.challenge;
};
