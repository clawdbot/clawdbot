/**
 * Public SDK subpath for setup-time command, archive, binary, and docs-link helpers.
 */
export { formatCliCommand } from "../cli/command-format.js";
export { extractArchive } from "../infra/archive.js";
export { resolveBrewExecutable } from "../infra/brew.js";
export { detectBinary } from "../plugins/setup-binary.js";
export { formatDocsLink } from "../../packages/terminal-core/src/links.js";
export { CONFIG_DIR } from "../utils.js";
