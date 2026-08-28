// Memory Wiki plugin module implements source path shared behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { lowercasePreservingWhitespace } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createWikiPageFilename, slugifyWikiSegment } from "./markdown.js";

export async function resolveArtifactKey(absolutePath: string): Promise<string> {
  const canonicalPath = await fs.realpath(absolutePath).catch(() => path.resolve(absolutePath));
  return process.platform === "win32"
    ? lowercasePreservingWhitespace(canonicalPath)
    : canonicalPath;
}

// Unsafe-local page identity derives from the configured root and the raw
// source path; ownership keys must bind the same pair (#118370).
export function resolveUnsafeLocalPagePath(params: {
  configuredPath: string;
  absolutePath: string;
}): {
  pageId: string;
  pagePath: string;
} {
  const configuredBaseSlug = slugifyWikiSegment(path.basename(params.configuredPath));
  const configuredHash = createHash("sha1")
    .update(path.resolve(params.configuredPath))
    .digest("hex")
    .slice(0, 8);
  const artifactBaseSlug = slugifyWikiSegment(path.basename(params.absolutePath));
  const artifactHash = createHash("sha1")
    .update(path.resolve(params.absolutePath))
    .digest("hex")
    .slice(0, 8);
  const pageSlug = `${configuredBaseSlug}-${configuredHash}-${artifactBaseSlug}-${artifactHash}`;
  return {
    pageId: `source.unsafe-local.${pageSlug}`,
    pagePath: path
      .join("sources", createWikiPageFilename(`unsafe-local-${pageSlug}`))
      .replace(/\\/g, "/"),
  };
}
