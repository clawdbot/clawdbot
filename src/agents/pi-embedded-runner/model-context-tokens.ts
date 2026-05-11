import type { Api, Model } from "@earendil-works/pi-ai";

type PiModelWithOptionalContextTokens = Model<Api> & {
  contextTokens?: number;
};

export function readPiModelContextTokens(model: Model<Api> | null | undefined): number | undefined {
  const value = (model as PiModelWithOptionalContextTokens | null | undefined)?.contextTokens;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
