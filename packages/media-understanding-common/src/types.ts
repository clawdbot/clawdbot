// Shared media-understanding provider, attachment, output, and capability contracts.

/** Kind of media-understanding output produced for an attachment. */
export type MediaUnderstandingKind =
  | "audio.transcription"
  | "video.description"
  | "image.description";

/** Capability exposed by a media-understanding provider. */
export type MediaUnderstandingCapability = "image" | "audio" | "video";

/** Capability registry keyed by provider id. */
export type MediaUnderstandingCapabilityRegistry = Map<
  string,
  {
    capabilities?: MediaUnderstandingCapability[];
  }
>;

/** Media attachment passed to understanding providers. */
export type MediaAttachment = {
  path?: string;
  url?: string;
  mime?: string;
  index: number;
  alreadyTranscribed?: boolean;
};

/** Normalized text output produced by media understanding. */
export type MediaUnderstandingOutput = {
  kind: MediaUnderstandingKind;
  attachmentIndex: number;
  text: string;
  provider: string;
  model?: string;
};

/** Provider shape used for capability discovery and dispatch. */
export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  transcribeAudio?: unknown;
  describeVideo?: unknown;
  describeImage?: unknown;
  describeImages?: unknown;
  extractStructured?: unknown;
};
