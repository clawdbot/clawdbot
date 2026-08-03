// Diagnostic support bundle helpers collect logs and metadata for support exports.
import fsp from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";

// File builders and writers for redacted diagnostic support bundles.
export type DiagnosticSupportBundleFile = {
  path: string;
  mediaType: string;
  content: string;
};

/** Manifest entry for one written support bundle file. */
export type DiagnosticSupportBundleContent = {
  path: string;
  mediaType: string;
  bytes: number;
};

function supportBundleByteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/** Creates a JSON support-bundle file with a safe relative path. */
export function jsonSupportBundleFile(
  pathName: string,
  value: unknown,
): DiagnosticSupportBundleFile {
  return {
    path: assertSafeBundleRelativePath(pathName),
    mediaType: "application/json",
    content: `${JSON.stringify(value, null, 2)}\n`,
  };
}

/** Creates an NDJSON support-bundle file with a safe relative path. */
export function jsonlSupportBundleFile(
  pathName: string,
  lines: readonly string[],
): DiagnosticSupportBundleFile {
  return {
    path: assertSafeBundleRelativePath(pathName),
    mediaType: "application/x-ndjson",
    content: `${lines.join("\n")}\n`,
  };
}

/** Creates a UTF-8 text support-bundle file with a safe relative path. */
export function textSupportBundleFile(
  pathName: string,
  content: string,
): DiagnosticSupportBundleFile {
  return {
    path: assertSafeBundleRelativePath(pathName),
    mediaType: "text/plain; charset=utf-8",
    content: content.endsWith("\n") ? content : `${content}\n`,
  };
}

/** Summarizes support-bundle files for the bundle manifest. */
export function supportBundleContents(
  files: readonly DiagnosticSupportBundleFile[],
): DiagnosticSupportBundleContent[] {
  return files.map((file) => ({
    path: file.path,
    mediaType: file.mediaType,
    bytes: supportBundleByteLength(file.content),
  }));
}

function assertSafeBundleRelativePath(pathName: string): string {
  const normalized = pathName.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid bundle file path: ${pathName}`);
  }
  return normalized;
}

async function prepareSupportBundleDirectory(outputDir: string): Promise<void> {
  await fsp.mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await fsp.mkdir(outputDir, { mode: 0o700 });
}

function resolveSupportBundleFilePath(outputDir: string, pathName: string): string {
  const safePath = assertSafeBundleRelativePath(pathName);
  const resolvedBase = path.resolve(outputDir);
  const resolvedFile = path.resolve(resolvedBase, safePath);
  // Re-check after path.resolve so crafted relative paths cannot escape the output directory.
  if (resolvedFile === resolvedBase || !isPathInside(resolvedBase, resolvedFile)) {
    throw new Error(`Bundle file path escaped output directory: ${pathName}`);
  }
  return resolvedFile;
}

async function writeSupportBundleFile(
  outputDir: string,
  file: DiagnosticSupportBundleFile,
): Promise<void> {
  const filePath = resolveSupportBundleFilePath(outputDir, file.path);
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, file.content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

/** Writes support-bundle files to a new private directory. */
export async function writeSupportBundleDirectory(params: {
  outputDir: string;
  files: readonly DiagnosticSupportBundleFile[];
}): Promise<DiagnosticSupportBundleContent[]> {
  await prepareSupportBundleDirectory(params.outputDir);
  for (const file of params.files) {
    await writeSupportBundleFile(params.outputDir, file);
  }
  return supportBundleContents(params.files);
}

/** Writes support-bundle files to a private zip archive and returns its byte size. */
export async function writeSupportBundleZip(params: {
  outputPath: string;
  files: readonly DiagnosticSupportBundleFile[];
  compressionLevel?: number;
}): Promise<number> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const file of params.files) {
    zip.file(assertSafeBundleRelativePath(file.path), file.content);
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: params.compressionLevel ?? 6 },
  });
  await fsp.mkdir(path.dirname(params.outputPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(params.outputPath, buffer, { mode: 0o600 });
  return buffer.length;
}
