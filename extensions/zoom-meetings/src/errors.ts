export class ZoomMeetingsInvalidRequestError extends Error {}

export function zoomMeetingsInvalidRequest(message: string): ZoomMeetingsInvalidRequestError {
  return new ZoomMeetingsInvalidRequestError(message);
}
