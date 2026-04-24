import { GoogleGenAI } from "@google/genai";

export type GoogleGenAIClient = InstanceType<typeof GoogleGenAI>;
export type GoogleGenAIOptions = ConstructorParameters<typeof GoogleGenAI>[0];

export function createGoogleGenAI(options: GoogleGenAIOptions): GoogleGenAIClient {
  return new GoogleGenAI(options);
}
