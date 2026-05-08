#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repairMintlifyAccordionIndentation } from "./lib/mintlify-accordion.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SOURCE_DOCS_DIR = path.join(ROOT, "docs");
const SOURCE_CONFIG_PATH = path.join(SOURCE_DOCS_DIR, "docs.json");
const INTERNAL_DOCS_DIRS = ["internal"];
const DEFAULT_CLAWHUB_SOURCE_REPO = "openclaw/clawhub";
const CLAWHUB_DOCS_TARGET_DIR = "clawhub";
const CLAWHUB_REPO_ENV = "OPENCLAW_DOCS_SYNC_CLAWHUB_REPO";
const DEFAULT_CLAWHUB_REPO_CANDIDATES = [
  path.resolve(ROOT, "..", "clawhub-docs-clawhub"),
  path.resolve(ROOT, "..", "clawhub"),
];
const SYNC_SUPPORT_FILES = [
  {
    source: path.join(ROOT, "scripts", "check-docs-mdx.mjs"),
    target: path.join(".openclaw-sync", "check-docs-mdx.mjs"),
  },
  {
    source: path.join(ROOT, "scripts", "lib", "mintlify-accordion.mjs"),
    target: path.join(".openclaw-sync", "lib", "mintlify-accordion.mjs"),
  },
  {
    source: path.join(ROOT, ".github", "codex", "prompts", "docs-mdx-repair.md"),
    target: path.join(".openclaw-sync", "docs-mdx-repair.md"),
  },
];
const GENERATED_LOCALES = [
  {
    language: "zh-Hans",
    dir: "zh-CN",
    navFile: "zh-Hans-navigation.json",
    tmFile: "zh-CN.tm.jsonl",
    navMode: "overlay",
  },
  {
    language: "zh-Hant",
    dir: "zh-TW",
    navFile: "zh-Hant-navigation.json",
    tmFile: "zh-TW.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "ja",
    dir: "ja-JP",
    navFile: "ja-navigation.json",
    tmFile: "ja-JP.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "es",
    dir: "es",
    navFile: "es-navigation.json",
    tmFile: "es.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "pt-BR",
    dir: "pt-BR",
    navFile: "pt-BR-navigation.json",
    tmFile: "pt-BR.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "ko",
    dir: "ko",
    navFile: "ko-navigation.json",
    tmFile: "ko.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "de",
    dir: "de",
    navFile: "de-navigation.json",
    tmFile: "de.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "fr",
    dir: "fr",
    navFile: "fr-navigation.json",
    tmFile: "fr.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "ar",
    dir: "ar",
    navFile: "ar-navigation.json",
    tmFile: "ar.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "it",
    dir: "it",
    navFile: "it-navigation.json",
    tmFile: "it.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "vi",
    dir: "vi",
    navFile: "vi-navigation.json",
    tmFile: "vi.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "nl",
    dir: "nl",
    navFile: "nl-navigation.json",
    tmFile: "nl.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "fa",
    dir: "fa",
    navFile: "fa-navigation.json",
    tmFile: "fa.tm.jsonl",
    navMode: "clone-en",
    // Mintlify does not currently accept `fa` in navigation.languages.
    // Keep generated docs and translation memory so the locale stays available
    // once the docs host accepts it.
    navigation: false,
  },
  {
    language: "tr",
    dir: "tr",
    navFile: "tr-navigation.json",
    tmFile: "tr.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "uk",
    dir: "uk",
    navFile: "uk-navigation.json",
    tmFile: "uk.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "id",
    dir: "id",
    navFile: "id-navigation.json",
    tmFile: "id.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "pl",
    dir: "pl",
    navFile: "pl-navigation.json",
    tmFile: "pl.tm.jsonl",
    navMode: "clone-en",
  },
  {
    language: "th",
    dir: "th",
    navFile: "th-navigation.json",
    tmFile: "th.tm.jsonl",
    navMode: "clone-en",
    // Mintlify does not currently accept `th` in navigation.languages.
    // Keep generated docs and translation memory so the locale stays available
    // once the docs host accepts it.
    navigation: false,
  },
];

function parseArgs(argv) {
  const args = {
    target: "",
    sourceRepo: "",
    sourceSha: "",
    clawhubRepo: process.env[CLAWHUB_REPO_ENV] || "",
    clawhubSourceRepo:
      process.env.OPENCLAW_DOCS_SYNC_CLAWHUB_SOURCE_REPO || DEFAULT_CLAWHUB_SOURCE_REPO,
    clawhubSourceSha: process.env.OPENCLAW_DOCS_SYNC_CLAWHUB_SOURCE_SHA || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    switch (part) {
      case "--target":
        args.target = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--source-repo":
        args.sourceRepo = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--source-sha":
        args.sourceSha = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--clawhub-repo":
        args.clawhubRepo = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--clawhub-source-repo":
        args.clawhubSourceRepo = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--clawhub-source-sha":
        args.clawhubSourceSha = argv[index + 1] ?? "";
        index += 1;
        break;
      default:
        throw new Error(`unknown arg: ${part}`);
    }
  }

  if (!args.target) {
    throw new Error("missing --target");
  }

  return args;
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, "/");
}

function walkFiles(entryPath, out = []) {
  if (!fs.existsSync(entryPath)) {
    return out;
  }

  const stat = fs.statSync(entryPath);
  if (stat.isFile()) {
    out.push(entryPath);
    return out;
  }

  for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    walkFiles(path.join(entryPath, entry.name), out);
  }
  return out;
}

function walkMarkdownFiles(entryPath, out = []) {
  if (!fs.existsSync(entryPath)) {
    return out;
  }

  const stat = fs.statSync(entryPath);
  if (stat.isFile()) {
    if (/\.mdx?$/i.test(entryPath)) {
      out.push(entryPath);
    }
    return out;
  }

  for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    walkMarkdownFiles(path.join(entryPath, entry.name), out);
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getGitHeadSha(repoPath) {
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function resolveClawHubRepoPath(value = "", options = {}) {
  const required = options.required !== false;
  const candidates = [
    value,
    process.env[CLAWHUB_REPO_ENV] || "",
    ...DEFAULT_CLAWHUB_REPO_CANDIDATES,
  ].filter((candidate) => candidate.trim().length > 0);

  for (const candidate of candidates) {
    const repoPath = path.resolve(candidate);
    if (fs.existsSync(path.join(repoPath, "docs"))) {
      return repoPath;
    }
  }

  if (required) {
    throw new Error(`missing ClawHub docs source; pass --clawhub-repo or set ${CLAWHUB_REPO_ENV}`);
  }
  return "";
}

function prefixLocalePage(entry, localeDir) {
  if (typeof entry === "string") {
    return `${localeDir}/${entry}`;
  }
  if (Array.isArray(entry)) {
    return entry.map((item) => prefixLocalePage(item, localeDir));
  }
  if (!entry || typeof entry !== "object") {
    return entry;
  }

  const clone = { ...entry };
  if (typeof clone.page === "string") {
    clone.page = `${localeDir}/${clone.page}`;
  }
  if (Array.isArray(clone.pages)) {
    clone.pages = clone.pages.map((item) => prefixLocalePage(item, localeDir));
  }
  return clone;
}

function prefixLocaleNavGroup(group, localeDir) {
  const clone = { ...group };
  if (Array.isArray(clone.pages)) {
    clone.pages = clone.pages.map((entry) => prefixLocalePage(entry, localeDir));
  }
  return clone;
}

function prefixLocaleNavTab(tab, localeDir) {
  const clone = { ...tab };
  if (Array.isArray(clone.pages)) {
    clone.pages = clone.pages.map((entry) => prefixLocalePage(entry, localeDir));
  }
  if (Array.isArray(clone.groups)) {
    clone.groups = clone.groups.map((group) => prefixLocaleNavGroup(group, localeDir));
  }
  return clone;
}

function cloneEnglishLanguageNav(englishNav, locale) {
  if (!englishNav) {
    throw new Error("docs/docs.json is missing navigation.languages.en");
  }
  return {
    ...englishNav,
    language: locale.language,
    tabs: Array.isArray(englishNav.tabs)
      ? englishNav.tabs
          .filter((tab) => tab?.tab !== "ClawHub")
          .map((tab) => prefixLocaleNavTab(tab, locale.dir))
      : englishNav.tabs,
  };
}

function composeLocaleNav(locale, englishNav) {
  if (locale.navMode === "clone-en") {
    return cloneEnglishLanguageNav(englishNav, locale);
  }
  return readJson(path.join(SOURCE_DOCS_DIR, ".i18n", locale.navFile));
}

function composeDocsConfig() {
  const sourceConfig = readJson(SOURCE_CONFIG_PATH);
  const languages = sourceConfig?.navigation?.languages;

  if (!Array.isArray(languages)) {
    throw new Error("docs/docs.json is missing navigation.languages");
  }

  const englishNav = languages.find((entry) => entry?.language === "en");
  const generatedLanguageSet = new Set(
    GENERATED_LOCALES.filter((entry) => entry.navigation !== false).map((entry) => entry.language),
  );
  const withoutGenerated = languages.filter((entry) => !generatedLanguageSet.has(entry?.language));
  const enIndex = withoutGenerated.findIndex((entry) => entry?.language === "en");
  const generated = GENERATED_LOCALES.filter((entry) => entry.navigation !== false).map((entry) =>
    composeLocaleNav(entry, englishNav),
  );
  if (enIndex === -1) {
    withoutGenerated.push(...generated);
  } else {
    withoutGenerated.splice(enIndex + 1, 0, ...generated);
  }

  return {
    ...sourceConfig,
    navigation: {
      ...sourceConfig.navigation,
      languages: withoutGenerated,
    },
  };
}

function pruneOrphanLocaleDocs(targetDocsDir) {
  let pruned = 0;
  for (const locale of GENERATED_LOCALES) {
    const localeDir = path.join(targetDocsDir, locale.dir);
    if (!fs.existsSync(localeDir)) {
      continue;
    }
    for (const filePath of walkMarkdownFiles(localeDir)) {
      const relativeToLocale = path.relative(localeDir, filePath);
      // The English source file lives at docs/<relativeToLocale> with either .md or .mdx.
      const englishBase = path.join(SOURCE_DOCS_DIR, relativeToLocale);
      const englishMd = englishBase.replace(/\.mdx?$/i, ".md");
      const englishMdx = englishBase.replace(/\.mdx?$/i, ".mdx");
      if (fs.existsSync(englishMd) || fs.existsSync(englishMdx)) {
        continue;
      }
      fs.rmSync(filePath, { force: true });
      pruned += 1;
    }
  }

  if (pruned > 0) {
    console.log(`Pruned ${pruned} orphan localized doc(s) with no matching English source file.`);
  }
}

function repairGeneratedLocaleDocs(targetDocsDir) {
  let repaired = 0;
  for (const locale of GENERATED_LOCALES) {
    const localeDir = path.join(targetDocsDir, locale.dir);
    for (const filePath of walkMarkdownFiles(localeDir)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const repairedRaw = repairMintlifyAccordionIndentation(raw);
      if (repairedRaw === raw) {
        continue;
      }
      fs.writeFileSync(filePath, repairedRaw);
      repaired += 1;
    }
  }

  if (repaired > 0) {
    console.log(`Repaired Mintlify accordion indentation in ${repaired} generated locale doc(s).`);
  }
}

function pruneInternalDocs(targetDocsDir) {
  let pruned = 0;
  for (const relativeDir of INTERNAL_DOCS_DIRS) {
    const dirPath = path.join(targetDocsDir, relativeDir);
    if (!fs.existsSync(dirPath)) {
      continue;
    }
    fs.rmSync(dirPath, { recursive: true, force: true });
    pruned += 1;
  }

  if (pruned > 0) {
    console.log(`Pruned ${pruned} internal-only docs director${pruned === 1 ? "y" : "ies"}.`);
  }
}

function shouldExcludeClawHubDocsPath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  return (
    normalized === "specs" || normalized.startsWith("specs/") || normalized.includes("/specs/")
  );
}

function toClawHubTargetRelativePath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  if (normalized === "README.md") {
    return "";
  }
  if (normalized === "clawhub.md") {
    return "index.md";
  }
  return normalized.replace(/\/README\.md$/iu, "/index.md");
}

function toClawHubDocsRoute(relativePath) {
  const targetRelativePath = toClawHubTargetRelativePath(relativePath);
  if (!targetRelativePath) {
    return "";
  }

  const normalized = targetRelativePath.replace(/\.mdx?$/iu, "");
  if (normalized === "index") {
    return `/${CLAWHUB_DOCS_TARGET_DIR}`;
  }
  if (normalized.endsWith("/index")) {
    return `/${CLAWHUB_DOCS_TARGET_DIR}/${normalized.slice(0, -"/index".length)}`;
  }
  return `/${CLAWHUB_DOCS_TARGET_DIR}/${normalized}`;
}

function splitLinkTarget(value) {
  const match = /^(\S+)(.*)$/su.exec(value);
  return {
    target: match?.[1] ?? value,
    suffix: match?.[2] ?? "",
  };
}

function splitTargetParts(value) {
  const hashIndex = value.indexOf("#");
  const queryIndex = value.indexOf("?");
  const splitIndexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  const splitIndex = splitIndexes.length > 0 ? Math.min(...splitIndexes) : -1;
  if (splitIndex === -1) {
    return { pathPart: value, rest: "" };
  }
  return {
    pathPart: value.slice(0, splitIndex),
    rest: value.slice(splitIndex),
  };
}

function rewriteClawHubMarkdownLinkTarget(rawTarget, relativeSourceDir, source) {
  const { target, suffix } = splitLinkTarget(rawTarget);
  if (/^(?:https?:|mailto:|tel:|data:|#)/iu.test(target) || target.startsWith("/")) {
    return rawTarget;
  }

  const { pathPart, rest } = splitTargetParts(target);
  if (!pathPart) {
    return rawTarget;
  }

  let normalizedRelative = "";
  if (pathPart.startsWith("docs/")) {
    normalizedRelative = normalizeSlashes(pathPart.slice("docs/".length));
  } else if (
    pathPart.startsWith("./") ||
    pathPart.startsWith("../") ||
    /\.mdx?$/iu.test(pathPart)
  ) {
    normalizedRelative = normalizeSlashes(path.normalize(path.join(relativeSourceDir, pathPart)));
  } else {
    return rawTarget;
  }

  if (normalizedRelative.startsWith("../")) {
    const sourceRef = source.sha || "main";
    const repoRelative = normalizeSlashes(
      path.normalize(path.join("docs", relativeSourceDir, pathPart)),
    ).replace(/^(?:\.\.\/)+/u, "");
    return `https://github.com/${source.repository}/blob/${sourceRef}/${repoRelative}${rest}${suffix}`;
  }

  if (!/\.mdx?$/iu.test(normalizedRelative)) {
    return rawTarget;
  }

  const route = toClawHubDocsRoute(normalizedRelative);
  return route ? `${route}${rest}${suffix}` : rawTarget;
}

function rewriteClawHubMarkdownLinks(raw, relativeSourcePath, source) {
  const relativeSourceDir = normalizeSlashes(path.dirname(relativeSourcePath));
  const baseDir = relativeSourceDir === "." ? "" : relativeSourceDir;
  return raw.replace(/(!?\[[^\]]*\]\()([^)]+)(\))/gu, (_match, prefix, target, suffix) => {
    return `${prefix}${rewriteClawHubMarkdownLinkTarget(target, baseDir, source)}${suffix}`;
  });
}

export function syncClawHubDocsTree(targetDocsDir, options = {}) {
  const repoPath = resolveClawHubRepoPath(options.repoPath || "", {
    required: options.required !== false,
  });
  if (!repoPath) {
    return {
      repository: options.sourceRepo || DEFAULT_CLAWHUB_SOURCE_REPO,
      sha: options.sourceSha || "",
      path: "",
      files: 0,
    };
  }

  const sourceDocsDir = path.join(repoPath, "docs");
  const targetDir = path.join(targetDocsDir, CLAWHUB_DOCS_TARGET_DIR);
  const source = {
    repository: options.sourceRepo || DEFAULT_CLAWHUB_SOURCE_REPO,
    sha: options.sourceSha || getGitHeadSha(repoPath),
  };

  fs.rmSync(targetDir, { recursive: true, force: true });
  ensureDir(targetDir);

  let copied = 0;
  for (const sourcePath of walkFiles(sourceDocsDir)) {
    const relativeSourcePath = normalizeSlashes(path.relative(sourceDocsDir, sourcePath));
    if (shouldExcludeClawHubDocsPath(relativeSourcePath)) {
      continue;
    }

    const targetRelativePath = toClawHubTargetRelativePath(relativeSourcePath);
    if (!targetRelativePath) {
      continue;
    }
    const targetPath = path.join(targetDir, targetRelativePath);
    ensureDir(path.dirname(targetPath));

    if (/\.mdx?$/iu.test(sourcePath)) {
      const raw = fs.readFileSync(sourcePath, "utf8");
      fs.writeFileSync(
        targetPath,
        rewriteClawHubMarkdownLinks(raw, relativeSourcePath, source),
        "utf8",
      );
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
    copied += 1;
  }

  console.log(`Synced ${copied} ClawHub doc asset(s) from ${repoPath}.`);
  return {
    ...source,
    path: repoPath,
    files: copied,
  };
}

function syncDocsTree(targetRoot, options = {}) {
  const targetDocsDir = path.join(targetRoot, "docs");
  ensureDir(targetDocsDir);

  const localeFilters = GENERATED_LOCALES.flatMap((entry) => [
    "--filter",
    `P ${entry.dir}/`,
    "--filter",
    `P .i18n/${entry.tmFile}`,
    "--exclude",
    `${entry.dir}/`,
    "--exclude",
    `.i18n/${entry.tmFile}`,
  ]);

  run("rsync", [
    "-a",
    "--delete",
    "--filter",
    "P .i18n/README.md",
    "--exclude",
    ".i18n/README.md",
    ...INTERNAL_DOCS_DIRS.flatMap((dir) => ["--exclude", `${dir}/`]),
    ...localeFilters,
    `${SOURCE_DOCS_DIR}/`,
    `${targetDocsDir}/`,
  ]);
  pruneInternalDocs(targetDocsDir);

  for (const locale of GENERATED_LOCALES) {
    const sourceTmPath = path.join(SOURCE_DOCS_DIR, ".i18n", locale.tmFile);
    const targetTmPath = path.join(targetDocsDir, ".i18n", locale.tmFile);
    if (!fs.existsSync(targetTmPath) && fs.existsSync(sourceTmPath)) {
      ensureDir(path.dirname(targetTmPath));
      fs.copyFileSync(sourceTmPath, targetTmPath);
    }
  }

  const clawhubSource = syncClawHubDocsTree(targetDocsDir, {
    repoPath: options.clawhubRepo,
    sourceRepo: options.clawhubSourceRepo,
    sourceSha: options.clawhubSourceSha,
  });
  pruneOrphanLocaleDocs(targetDocsDir);
  repairGeneratedLocaleDocs(targetDocsDir);
  writeJson(path.join(targetDocsDir, "docs.json"), composeDocsConfig());
  return { clawhub: clawhubSource };
}

function writeSyncMetadata(targetRoot, args, sources) {
  const metadata = {
    repository: args.sourceRepo || "",
    sha: args.sourceSha || "",
    sources: {
      openclaw: {
        repository: args.sourceRepo || "",
        sha: args.sourceSha || "",
      },
      clawhub: {
        repository:
          sources.clawhub.repository || args.clawhubSourceRepo || DEFAULT_CLAWHUB_SOURCE_REPO,
        sha: sources.clawhub.sha || args.clawhubSourceSha || "",
      },
    },
    syncedAt: new Date().toISOString(),
  };
  writeJson(path.join(targetRoot, ".openclaw-sync", "source.json"), metadata);
}

function syncSupportFiles(targetRoot) {
  for (const entry of SYNC_SUPPORT_FILES) {
    const targetPath = path.join(targetRoot, entry.target);
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(entry.source, targetPath);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetRoot = path.resolve(args.target);

  if (!fs.existsSync(targetRoot)) {
    throw new Error(`target does not exist: ${targetRoot}`);
  }

  const clawhubRepo = resolveClawHubRepoPath(args.clawhubRepo);
  const sources = syncDocsTree(targetRoot, {
    clawhubRepo,
    clawhubSourceRepo: args.clawhubSourceRepo,
    clawhubSourceSha: args.clawhubSourceSha,
  });
  syncSupportFiles(targetRoot);
  writeSyncMetadata(targetRoot, args, sources);
}

function isCliEntry() {
  const cliArg = process.argv[1];
  return cliArg ? import.meta.url === pathToFileURL(cliArg).href : false;
}

if (isCliEntry()) {
  main();
}
