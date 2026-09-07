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
  kind?: "image" | "audio" | "video" | "document" | "sticker" | "unknown";
  /**
   * Name the sender gave the file, when the channel recorded one. Channels stage
   * a download under a generated name, so `path` cannot answer "what's in
   * notes.txt?"; this is the only name the user can refer to. Untrusted input:
   * display only, never format detection.
   */
  fileName?: string;
  workspaceDir?: string;
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
  requestedBackend?: string;
  observedBackend?: string;
};
