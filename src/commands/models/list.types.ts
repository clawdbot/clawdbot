// Shared data shapes for model-list and model-status output.
/** Configured model entry plus tags/aliases used by row builders. */
export type ConfiguredEntry = {
  key: string;
  ref: { provider: string; model: string };
  tags: Set<string>;
  aliases: string[];
};

/** Render-ready model-list row. */
export type ModelRow = {
  key: string;
  name: string;
  input: string;
  contextWindow: number | null;
  contextTokens?: number;
  local: boolean | null;
  available: boolean | null;
  tags: string[];
  missing: boolean;
};

/** Provider auth summary shown by `models status`. */
export type ProviderAuthOverview = {
  provider: string;
  effective: {
    kind: "profiles" | "env" | "models.json" | "synthetic" | "runtime" | "missing";
    detail: string;
  };
  profiles: {
    count: number;
    oauth: number;
    token: number;
    apiKey: number;
    labels: string[];
  };
  env?: { value: string; source: string };
  modelsJson?: { value: string; source: string };
  syntheticAuth?: { value: string; source: string };
};
