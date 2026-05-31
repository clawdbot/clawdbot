//#region packages/media-understanding-common/src/errors.d.ts
type MediaUnderstandingSkipReason = "maxBytes" | "timeout" | "unsupported" | "empty" | "blocked" | "tooSmall";
declare class MediaUnderstandingSkipError extends Error {
  readonly reason: MediaUnderstandingSkipReason;
  constructor(reason: MediaUnderstandingSkipReason, message: string);
}
declare function isMediaUnderstandingSkipError(err: unknown): err is MediaUnderstandingSkipError;
//#endregion
export { MediaUnderstandingSkipError, isMediaUnderstandingSkipError };