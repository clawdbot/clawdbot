// Public media-understanding helpers and types for provider plugins.
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

export type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  ImageDescriptionRequest,
  ImageDescriptionResult,
  ImagesDescriptionInput,
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
  MediaUnderstandingProvider,
  MediaUnderstandingProviderAuthContext,
  MediaUnderstandingProviderAuthResult,
  MediaUnderstandingProviderRequestAuth,
  MediaUnderstandingProviderSyntheticAuthResult,
  StructuredExtractionImageInput,
  StructuredExtractionInput,
  StructuredExtractionRequest,
  StructuredExtractionResult,
  StructuredExtractionTextInput,
  VideoDescriptionRequest,
  VideoDescriptionResult,
} from "../media-understanding/types.js";

export {
  describeImageWithModel,
  describeImageWithModelPayloadTransform,
  describeImagesWithModel,
  describeImagesWithModelPayloadTransform,
} from "../media-understanding/image-runtime.js";
export {
  buildOpenAiCompatibleVideoRequestBody,
  coerceOpenAiCompatibleVideoText,
  resolveMediaUnderstandingString,
  type OpenAiCompatibleVideoPayload,
} from "../../packages/media-understanding-common/src/openai-compatible-video.js";

/** Describes a video through an OpenAI-compatible chat-completions endpoint. */
export const describeOpenAiCompatibleVideo = createLazyRuntimeMethod(
  createLazyRuntimeModule(() => import("../media-understanding/openai-compatible-video.js")),
  (runtime) => runtime.describeOpenAiCompatibleVideoCore,
);

/** Transcribes audio through an OpenAI-compatible endpoint. */
export const transcribeOpenAiCompatibleAudio = createLazyRuntimeMethod(
  createLazyRuntimeModule(() => import("../media-understanding/openai-compatible-audio.js")),
  (runtime) => runtime.transcribeOpenAiCompatibleAudioCore,
);
