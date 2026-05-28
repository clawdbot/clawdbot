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
import { bundledLanguages } from "../extensions/diffs/src/shiki-curated-languages.js";
export * from "@shikijs/core";
export {
  bundledLanguages,
  bundledLanguagesAlias,
  bundledLanguagesBase,
  bundledLanguagesInfo,
} from "../extensions/diffs/src/shiki-curated-languages.js";
export { bundledThemes, bundledThemesInfo } from "shiki/themes";
import { bundledThemes } from "shiki/themes";

export type BundledLanguage = keyof typeof bundledLanguages;
export type BundledTheme = keyof typeof bundledThemes;

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
