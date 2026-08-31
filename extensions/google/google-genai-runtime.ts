// Google plugin module implements google genai runtime behavior.
import { GoogleGenAI, type GoogleGenAIOptions } from "@google/genai";
import { resolveGoogleApiClientHeaders } from "./google-api-client-header.js";

export type GoogleGenAIClient = InstanceType<typeof GoogleGenAI>;

export function createGoogleGenAI(options: GoogleGenAIOptions): GoogleGenAIClient {
  const httpOptions = options.httpOptions ?? {};
  return new GoogleGenAI({
    ...options,
    httpOptions: {
      ...httpOptions,
      headers: {
        ...httpOptions.headers,
        ...resolveGoogleApiClientHeaders({
          baseUrl: typeof httpOptions.baseUrl === "string" ? httpOptions.baseUrl : undefined,
        }),
      },
    },
  });
}
