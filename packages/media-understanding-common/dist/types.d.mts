//#region packages/media-understanding-common/src/types.d.ts
type MediaUnderstandingKind = "audio.transcription" | "video.description" | "image.description";
type MediaUnderstandingCapability = "image" | "audio" | "video";
type MediaUnderstandingCapabilityRegistry = Map<string, {
  capabilities?: MediaUnderstandingCapability[];
}>;
type MediaAttachment = {
  path?: string;
  url?: string;
  mime?: string;
  index: number;
  alreadyTranscribed?: boolean;
};
type MediaUnderstandingOutput = {
  kind: MediaUnderstandingKind;
  attachmentIndex: number;
  text: string;
  provider: string;
  model?: string;
};
type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  transcribeAudio?: unknown;
  describeVideo?: unknown;
  describeImage?: unknown;
  describeImages?: unknown;
  extractStructured?: unknown;
};
//#endregion
export { MediaAttachment, MediaUnderstandingCapability, MediaUnderstandingCapabilityRegistry, MediaUnderstandingKind, MediaUnderstandingOutput, MediaUnderstandingProvider };