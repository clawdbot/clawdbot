export class TeamsMeetingsInvalidRequestError extends Error {}

export function teamsMeetingsInvalidRequest(message: string): TeamsMeetingsInvalidRequestError {
  return new TeamsMeetingsInvalidRequestError(message);
}
