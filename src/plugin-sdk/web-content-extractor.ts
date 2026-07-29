/**
 * Public SDK subpath for web content extractor plugin types and HTML cleanup helpers.
 */
export type {
  WebContentExtractionRequest,
  WebContentExtractionResult,
  WebContentExtractorPlugin,
  WebContentExtractMode,
} from "../plugins/web-content-extractor-types.js";
export {
  extractBasicHtmlContent,
  htmlToMarkdown,
  markdownToText,
  normalizeWhitespace,
} from "../agents/tools/web-fetch-utils.js";
export { sanitizeHtml, stripInvisibleUnicode } from "../agents/tools/web-fetch-visibility.js";
