//#region packages/media-understanding-common/src/openai-compatible-video.d.ts
type OpenAiCompatibleVideoPayload = {
  choices?: Array<{
    message?: {
      content?: string | Array<{
        text?: string;
      }>;
      reasoning_content?: string;
    };
  }>;
};
declare function resolveMediaUnderstandingString(value: string | undefined, fallback: string): string;
declare function coerceOpenAiCompatibleVideoText(payload: OpenAiCompatibleVideoPayload): string | null;
declare function buildOpenAiCompatibleVideoRequestBody(params: {
  model: string;
  prompt: string;
  mime: string;
  buffer: Buffer;
}): {
  model: string;
  messages: {
    role: string;
    content: ({
      type: string;
      text: string;
      video_url?: undefined;
    } | {
      type: string;
      video_url: {
        url: string;
      };
      text?: undefined;
    })[];
  }[];
};
//#endregion
export { OpenAiCompatibleVideoPayload, buildOpenAiCompatibleVideoRequestBody, coerceOpenAiCompatibleVideoText, resolveMediaUnderstandingString };