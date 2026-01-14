import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function detectPackageManager(ua = process.env.npm_config_user_agent ?? "") {
  // Examples:
  // - "pnpm/10.23.0 npm/? node/v22.21.1 darwin arm64"
  // - "npm/10.9.4 node/v22.12.0 linux x64"
  // - "bun/1.2.2"
  const normalized = String(ua).trim();
  if (normalized.startsWith("pnpm/")) return "pnpm";
  if (normalized.startsWith("bun/")) return "bun";
  if (normalized.startsWith("npm/")) return "npm";
  if (normalized.startsWith("yarn/")) return "yarn";
  return "unknown";
}

function shouldApplyPnpmPatchedDependenciesFallback(pm = detectPackageManager()) {
  // pnpm already applies pnpm.patchedDependencies itself; re-applying would fail.
  return pm !== "pnpm";
}

function getRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function ensureExecutable(targetPath) {
  if (process.platform === "win32") return;
  if (!fs.existsSync(targetPath)) return;
  try {
    const mode = fs.statSync(targetPath).mode & 0o777;
    if (mode & 0o100) return;
    fs.chmodSync(targetPath, 0o755);
  } catch (err) {
    console.warn(`[postinstall] chmod failed: ${err}`);
  }
}

function extractPackageName(key) {
  if (key.startsWith("@")) {
    const idx = key.indexOf("@", 1);
    if (idx === -1) return key;
    return key.slice(0, idx);
  }
  const idx = key.lastIndexOf("@");
  if (idx <= 0) return key;
  return key.slice(0, idx);
}

function stripPrefix(p) {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function parseRange(segment) {
  // segment: "-12,5" or "+7"
  const [startRaw, countRaw] = segment.slice(1).split(",");
  const start = Number.parseInt(startRaw, 10);
  const count = countRaw ? Number.parseInt(countRaw, 10) : 1;
  if (Number.isNaN(start) || Number.isNaN(count)) {
    throw new Error(`invalid hunk range: ${segment}`);
  }
  return { start, count };
}

function parsePatch(patchText) {
  const lines = patchText.split("\n");
  const files = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      i += 1;
      continue;
    }

    const file = { oldPath: null, newPath: null, hunks: [] };
    i += 1;

    // Skip index line(s)
    while (i < lines.length && lines[i].startsWith("index ")) i += 1;

    if (i < lines.length && lines[i].startsWith("--- ")) {
      file.oldPath = stripPrefix(lines[i].slice(4).trim());
      i += 1;
    }
    if (i < lines.length && lines[i].startsWith("+++ ")) {
      file.newPath = stripPrefix(lines[i].slice(4).trim());
      i += 1;
    }

    while (i < lines.length && lines[i].startsWith("@@")) {
      const header = lines[i];
      const match = /^@@\s+(-\d+(?:,\d+)?)\s+(\+\d+(?:,\d+)?)\s+@@/.exec(header);
      if (!match) throw new Error(`invalid hunk header: ${header}`);
      const oldRange = parseRange(match[1]);
      const newRange = parseRange(match[2]);
      i += 1;

      const hunkLines = [];
      while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith("@@") || line.startsWith("diff --git ")) break;
        if (line === "") {
          i += 1;
          continue;
        }
        if (line.startsWith("\\ No newline at end of file")) {
          i += 1;
          continue;
        }
        hunkLines.push(line);
        i += 1;
      }

      file.hunks.push({
        oldStart: oldRange.start,
        oldLines: oldRange.count,
        newStart: newRange.start,
        newLines: newRange.count,
        lines: hunkLines,
      });
    }

    if (file.newPath && file.hunks.length > 0) {
      files.push(file);
    }
  }

  return files;
}

function readFileLines(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`target file missing: ${targetPath}`);
  }
  const raw = fs.readFileSync(targetPath, "utf-8");
  const hasTrailingNewline = raw.endsWith("\n");
  const parts = raw.split("\n");
  if (hasTrailingNewline) parts.pop();
  return { lines: parts, hasTrailingNewline };
}

function writeFileLines(targetPath, lines, hadTrailingNewline) {
  const content = lines.join("\n") + (hadTrailingNewline ? "\n" : "");
  fs.writeFileSync(targetPath, content, "utf-8");
}

function applyHunk(lines, hunk, offset) {
  let cursor = hunk.oldStart - 1 + offset;
  const expected = [];
  for (const raw of hunk.lines) {
    const marker = raw[0];
    if (marker === " " || marker === "+") {
      expected.push(raw.slice(1));
    }
  }
  if (cursor >= 0 && cursor + expected.length <= lines.length) {
    let alreadyApplied = true;
    for (let i = 0; i < expected.length; i += 1) {
      if (lines[cursor + i] !== expected[i]) {
        alreadyApplied = false;
        break;
      }
    }
    if (alreadyApplied) {
      const delta = hunk.newLines - hunk.oldLines;
      return offset + delta;
    }
  }

  for (const raw of hunk.lines) {
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === " ") {
      if (lines[cursor] !== text) {
        throw new Error(
          `context mismatch at line ${cursor + 1}: expected "${text}", found "${lines[cursor] ?? "<eof>"}"`,
        );
      }
      cursor += 1;
    } else if (marker === "-") {
      if (lines[cursor] !== text) {
        throw new Error(
          `delete mismatch at line ${cursor + 1}: expected "${text}", found "${lines[cursor] ?? "<eof>"}"`,
        );
      }
      lines.splice(cursor, 1);
    } else if (marker === "+") {
      lines.splice(cursor, 0, text);
      cursor += 1;
    } else {
      throw new Error(`unexpected hunk marker: ${marker}`);
    }
  }

  const delta = hunk.newLines - hunk.oldLines;
  return offset + delta;
}

function applyPatchToFile(targetDir, filePatch) {
  if (filePatch.newPath === "/dev/null") {
    // deletion not needed for our patches
    return;
  }
  const relPath = stripPrefix(filePatch.newPath ?? filePatch.oldPath ?? "");
  const targetPath = path.join(targetDir, relPath);
  const { lines, hasTrailingNewline } = readFileLines(targetPath);

  let offset = 0;
  for (const hunk of filePatch.hunks) {
    offset = applyHunk(lines, hunk, offset);
  }

  writeFileLines(targetPath, lines, hasTrailingNewline);
}

function applyPatchSet({ patchText, targetDir }) {
  let resolvedTarget = path.resolve(targetDir);
  if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isDirectory()) {
    console.warn(`[postinstall] skip missing target: ${resolvedTarget}`);
    return;
  }
  resolvedTarget = fs.realpathSync(resolvedTarget);

  const files = parsePatch(patchText);
  if (files.length === 0) return;

  for (const filePatch of files) {
    applyPatchToFile(resolvedTarget, filePatch);
  }
}

function applyPatchFile({ patchPath, targetDir }) {
  const absPatchPath = path.resolve(patchPath);
  if (!fs.existsSync(absPatchPath)) {
    throw new Error(`missing patch: ${absPatchPath}`);
  }
  const patchText = fs.readFileSync(absPatchPath, "utf-8");
  applyPatchSet({ patchText, targetDir });
}

function main() {
  const repoRoot = getRepoRoot();
  process.chdir(repoRoot);

  ensureExecutable(path.join(repoRoot, "dist", "entry.js"));

  if (!shouldApplyPnpmPatchedDependenciesFallback()) {
    return;
  }

  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const patched = pkg?.pnpm?.patchedDependencies ?? {};

  // Bun does not support pnpm.patchedDependencies. Apply these patch files to
  // node_modules packages as a best-effort compatibility layer.
  for (const [key, relPatchPath] of Object.entries(patched)) {
    if (typeof relPatchPath !== "string" || !relPatchPath.trim()) continue;
    const pkgName = extractPackageName(String(key));
    if (!pkgName) continue;
    applyPatchFile({
      targetDir: path.join("node_modules", ...pkgName.split("/")),
      patchPath: relPatchPath,
    });
  }
}

try {
  const skip =
    process.env.CLAWDBOT_SKIP_POSTINSTALL === "1" ||
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test";

  if (!skip) {
    main();
  }
} catch (err) {
  console.error(String(err));
  process.exit(1);
}

export {
  applyPatchFile,
  applyPatchSet,
  applyPatchToFile,
  detectPackageManager,
  parsePatch,
  shouldApplyPnpmPatchedDependenciesFallback,
};
