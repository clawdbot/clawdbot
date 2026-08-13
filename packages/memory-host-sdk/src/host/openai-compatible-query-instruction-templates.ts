type OpenAICompatibleQueryInstructionTemplate = {
  aliases: readonly string[];
  template: string;
};

const OPENAI_COMPATIBLE_QUERY_INSTRUCTION_TEMPLATES = [
  {
    aliases: [
      "qwen3-embedding-0.6b",
      "qwen3-embedding-4b",
      "qwen3-embedding-8b",
      "qwen3-embedding:0.6b",
      "qwen3-embedding:4b",
      "qwen3-embedding:8b",
    ],
    template:
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:{query}",
  },
  {
    aliases: ["mxbai-embed-large-v1"],
    template: "Represent this sentence for searching relevant passages: {query}",
  },
] as const satisfies readonly OpenAICompatibleQueryInstructionTemplate[];

function normalizeTemplateMatchModel(model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const segments = normalizedModel.split("/").filter(Boolean);
  return segments.at(-1) ?? normalizedModel;
}

function matchesTemplateModelAlias(model: string, alias: string): boolean {
  return model === alias;
}

export function applyOpenAICompatibleEmbeddingQueryInstructionTemplate(
  model: string,
  queryText: string,
): string {
  const normalizedModel = normalizeTemplateMatchModel(model);
  const match = OPENAI_COMPATIBLE_QUERY_INSTRUCTION_TEMPLATES.find(({ aliases }) =>
    aliases.some((alias) => matchesTemplateModelAlias(normalizedModel, alias)),
  );
  return match ? match.template.replace("{query}", () => queryText) : queryText;
}
