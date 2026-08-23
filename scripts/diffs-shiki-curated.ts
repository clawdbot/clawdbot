// Diffs Shiki Curated script supports OpenClaw repository automation.
import {
  createBundledHighlighter,
  createCssVariablesTheme,
  createSingletonShorthands,
  getTokenStyleObject,
  guessEmbeddedLanguages,
  normalizeTheme,
  stringifyTokenStyle,
} from "@shikijs/core";
import {
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor,
} from "@shikijs/engine-javascript";
import { createOnigurumaEngine, loadWasm } from "@shikijs/engine-oniguruma";
import {
  bundledLanguagesBase,
  bundledLanguagesInfo,
} from "../extensions/diffs/src/shiki-curated-languages.js";
export * from "@shikijs/core";
export { bundledLanguagesBase, bundledLanguagesInfo };
export { bundledThemes, bundledThemesInfo } from "shiki/themes";
import { bundledThemes } from "shiki/themes";

export const bundledLanguagesAlias = Object.fromEntries(
  bundledLanguagesInfo.flatMap((language) =>
    ("aliases" in language ? language.aliases : []).map((alias) => [alias, language.import]),
  ),
);
export const bundledLanguages = {
  ...bundledLanguagesBase,
  ...bundledLanguagesAlias,
};

export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createOnigurumaEngine(import("shiki/wasm")),
});

const shorthands = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });

export const codeToHtml = shorthands.codeToHtml;
export const codeToHast = shorthands.codeToHast;
export const codeToTokens = shorthands.codeToTokens;
export const codeToTokensBase = shorthands.codeToTokensBase;
export const codeToTokensWithThemes = shorthands.codeToTokensWithThemes;
export const getSingletonHighlighter = shorthands.getSingletonHighlighter;
export const getLastGrammarState = shorthands.getLastGrammarState;
export {
  createCssVariablesTheme,
  createJavaScriptRegexEngine,
  createOnigurumaEngine,
  defaultJavaScriptRegexConstructor,
  getTokenStyleObject,
  loadWasm,
  normalizeTheme,
  stringifyTokenStyle,
};
