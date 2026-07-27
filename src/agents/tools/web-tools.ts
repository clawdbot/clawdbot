/**
 * Barrel for web_fetch and web_search tool factories.
 *
 * Higher-level tool assembly imports this narrow module so tests can mock both
 * web tools together without loading provider-specific implementations.
 */
export { createWebFetchTool } from "./web-fetch.js";
export { createWebSearchTool } from "./web-search.js";
