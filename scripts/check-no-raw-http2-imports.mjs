import fs from "node:fs";
import path from "node:path";
const SOURCE_ROOTS = ["src", "extensions"];
const DEFAULT_SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", "coverage", ".generated"]);

function isCodeFile(filePath) {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  return /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(filePath);
}

function collectFilesSync(rootDir, options) {
  const skipDirNames = options.skipDirNames ?? DEFAULT_SKIPPED_DIR_NAMES;
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirNames.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && options.includeFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function toPosixPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

const FORBIDDEN_HTTP2_MODULES = new Set(["node:http2", "http2"]);
const ALLOWED_PRODUCTION_FILES = new Set(["src/infra/push-apns-http2.ts"]);

function isTestFile(relativePath) {
  return (
    /(?:^|\/)(?:test|test-fixtures)\//u.test(relativePath) ||
    /\.test\.[cm]?[jt]sx?$/u.test(relativePath)
  );
}

function lineNumberForOffset(content, offset) {
  return content.slice(0, offset).split(/\r?\n/u).length;
}

function collectHttp2ImportOffenders(filePath) {
  const relativePath = toPosixPath(path.relative(process.cwd(), filePath));
  if (ALLOWED_PRODUCTION_FILES.has(relativePath) || isTestFile(relativePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf8");
  const offenders = [];
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
    collectFilesSync(path.join(process.cwd(), root), {
      includeFile: isCodeFile,
    }),
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
