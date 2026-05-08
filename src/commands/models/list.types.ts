export type ConfiguredEntry = {
  key: string;
  ref: { provider: string; model: string };
  tags: Set<string>;
  aliases: string[];
};

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

export type ProviderAuthOverview = {
  provider: string;
  effective: {
    kind: "profiles" | "env" | "models.json" | "synthetic" | "missing";
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
