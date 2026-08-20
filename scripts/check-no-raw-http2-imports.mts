// Rejects raw Node http2 imports in source and extension code.
import fs from "node:fs";
import path from "node:path";
import { collectFilesSync, isCodeFile, toPosixPath } from "./check-file-utils.ts";

const SOURCE_ROOTS = ["src", "extensions"];

const FORBIDDEN_HTTP2_MODULES = new Set(["node:http2", "http2"]);
const ALLOWED_PRODUCTION_FILES = new Set(["src/infra/push-apns-http2.ts"]);

function isTestFile(relativePath: string) {
  return (
    /(?:^|\/)(?:test|test-fixtures)\//u.test(relativePath) ||
    /\.test\.[cm]?[jt]sx?$/u.test(relativePath)
  );
}

function lineNumberForOffset(content: string, offset: number) {
  return content.slice(0, offset).split(/\r?\n/u).length;
}

function collectHttp2ImportOffenders(filePath: string) {
  const relativePath = toPosixPath(path.relative(process.cwd(), filePath));
  if (ALLOWED_PRODUCTION_FILES.has(relativePath) || isTestFile(relativePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf8");
  const offenders: Array<{ file: string; line: number; specifier: string }> = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?[\s\S]*?\bfrom\s*["']([^"']+)["']/gu,
    /\bexport\s+(?:type\s+)?[\s\S]*?\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier && FORBIDDEN_HTTP2_MODULES.has(specifier)) {
        offenders.push({
          file: relativePath,
          line: lineNumberForOffset(content, match.index ?? 0),
          specifier,
        });
      }
    }
  }

  return offenders;
}

function collectSourceFiles() {
  return SOURCE_ROOTS.flatMap((root) =>
    collectFilesSync(path.join(process.cwd(), root), { includeFile: isCodeFile }),
  );
}

function main() {
  const offenders = collectSourceFiles().flatMap(collectHttp2ImportOffenders);
  if (offenders.length === 0) {
    console.log("OK: raw node:http2 imports stay behind the APNs proxy wrapper.");
    return;
  }

  console.error("Raw node:http2 imports are only allowed in src/infra/push-apns-http2.ts.");
  for (const offender of offenders.toSorted(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  )) {
    console.error(`- ${offender.file}:${offender.line} imports ${offender.specifier}`);
  }
  console.error("Use connectApnsHttp2Session() so APNs HTTP/2 honors managed proxy policy.");
  process.exit(1);
}

main();
