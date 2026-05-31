import { MediaUnderstandingOutput } from "./types.mjs";

//#region packages/media-understanding-common/src/format.d.ts
declare function extractMediaUserText(body?: string): string | undefined;
declare function formatMediaUnderstandingBody(params: {
  body?: string;
  outputs: MediaUnderstandingOutput[];
}): string;
declare function formatAudioTranscripts(outputs: MediaUnderstandingOutput[]): string;
//#endregion
export { extractMediaUserText, formatAudioTranscripts, formatMediaUnderstandingBody };