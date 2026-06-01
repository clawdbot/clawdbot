import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOONSHOT_KIMI_K2_CONTEXT_WINDOW,
  MOONSHOT_KIMI_K2_COST,
  MOONSHOT_KIMI_K2_INPUT,
  MOONSHOT_KIMI_K2_MAX_TOKENS,
  MOONSHOT_KIMI_K2_MODELS,
} from "../ui/src/ui/data/moonshot-kimi-k2";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function replaceBlockLines(
  text: string,
  startMarker: string,
  endMarker: string,
  lines: string[],
): string {
  const startIndex = text.indexOf(startMarker);
  if (startIndex === -1) {
    throw new Error(`Missing start marker: ${startMarker}`);
  }
  const endIndex = text.indexOf(endMarker, startIndex);
  if (endIndex === -1) {
    throw new Error(`Missing end marker: ${endMarker}`);
  }

  const startLineStart = text.lastIndexOf("\n", startIndex);
  const startLineStartIndex = startLineStart === -1 ? 0 : startLineStart + 1;
  const indent = text.slice(startLineStartIndex, startIndex);

  const endLineEnd = text.indexOf("\n", endIndex);
  const endLineEndIndex = endLineEnd === -1 ? text.length : endLineEnd + 1;

  const before = text.slice(0, startLineStartIndex);
  const after = text.slice(endLineEndIndex);

  const replacementLines = [
    `${indent}${startMarker}`,
    ...lines.map((line) => `${indent}${line}`),
    `${indent}${endMarker}`,
  ];

  const replacement = replacementLines.join("\n");
  if (!after) {
    return `${before}${replacement}`;
  }
  return `${before}${replacement}\n${after}`;
}

function renderKimiK2Ids(prefix: string) {
  return [...MOONSHOT_KIMI_K2_MODELS.map((model) => `- \`${prefix}${model.id}\``), ""];
}

function renderMoonshotAliases() {
  return MOONSHOT_KIMI_K2_MODELS.map((model, index) => {
    const isLast = index === MOONSHOT_KIMI_K2_MODELS.length - 1;
    const suffix = isLast ? "" : ",";
    return `"moonshot/${model.id}": { alias: "${model.alias}" }${suffix}`;
  });
}

function renderMoonshotModels() {
  const input = JSON.stringify([...MOONSHOT_KIMI_K2_INPUT]);
  const cost = `input: ${MOONSHOT_KIMI_K2_COST.input}, output: ${MOONSHOT_KIMI_K2_COST.output}, cacheRead: ${MOONSHOT_KIMI_K2_COST.cacheRead}, cacheWrite: ${MOONSHOT_KIMI_K2_COST.cacheWrite}`;

  return MOONSHOT_KIMI_K2_MODELS.flatMap((model, index) => {
    const isLast = index === MOONSHOT_KIMI_K2_MODELS.length - 1;
    const closing = isLast ? "}" : "},";
    return [
      "{",
      `  id: "${model.id}",`,
      `  name: "${model.name}",`,
      `  reasoning: ${model.reasoning},`,
      `  input: ${input},`,
      `  cost: { ${cost} },`,
      `  contextWindow: ${MOONSHOT_KIMI_K2_CONTEXT_WINDOW},`,
      `  maxTokens: ${MOONSHOT_KIMI_K2_MAX_TOKENS}`,
      closing,
    ];
  });
}

async function syncMoonshotDocs() {
  const moonshotDoc = path.join(repoRoot, "docs/providers/moonshot.md");
  const conceptsDoc = path.join(repoRoot, "docs/concepts/model-providers.md");

  let moonshotText = await readFile(moonshotDoc, "utf8");
  moonshotText = replaceBlockLines(
    moonshotText,
    '[//]: # "moonshot-kimi-k2-ids:start"',
    '[//]: # "moonshot-kimi-k2-ids:end"',
    renderKimiK2Ids(""),
  );
  moonshotText = replaceBlockLines(
    moonshotText,
    "// moonshot-kimi-k2-aliases:start",
    "// moonshot-kimi-k2-aliases:end",
    renderMoonshotAliases(),
  );
  moonshotText = replaceBlockLines(
    moonshotText,
    "// moonshot-kimi-k2-models:start",
    "// moonshot-kimi-k2-models:end",
    renderMoonshotModels(),
  );

  let conceptsText = await readFile(conceptsDoc, "utf8");
  conceptsText = replaceBlockLines(
    conceptsText,
    '[//]: # "moonshot-kimi-k2-model-refs:start"',
    '[//]: # "moonshot-kimi-k2-model-refs:end"',
    renderKimiK2Ids("moonshot/"),
  );

  await writeFile(moonshotDoc, moonshotText);
  await writeFile(conceptsDoc, conceptsText);
}

syncMoonshotDocs().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
