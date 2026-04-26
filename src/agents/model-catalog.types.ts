export type ModelInputType = "text" | "image" | "audio" | "video" | "document";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};
