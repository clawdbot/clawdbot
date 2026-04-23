#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SOURCE_DOCS_DIR = path.join(ROOT, "docs");
const SOURCE_CONFIG_PATH = path.join(SOURCE_DOCS_DIR, "docs.json");
const GENERATED_LOCALES = [
  {
    language: "zh-Hans",
    dir: "zh-CN",
    navFile: "zh-Hans-navigation.json",
    tmFile: "zh-CN.tm.jsonl",
    navMode: "overlay",
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
  },
];

function parseArgs(argv) {
  const args = {
    target: "",
    sourceRepo: "",
    sourceSha: "",
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function cloneEnglishLanguageNav(englishNav, locale) {
  if (!englishNav) {
    throw new Error("docs/docs.json is missing navigation.languages.en");
  }
  return {
    ...englishNav,
    language: locale.language,
    tabs: Array.isArray(englishNav.tabs)
      ? englishNav.tabs.map((tab) => ({
          ...tab,
          pages: Array.isArray(tab.pages)
            ? tab.pages.map((entry) => prefixLocalePage(entry, locale.dir))
            : tab.pages,
          groups: Array.isArray(tab.groups)
            ? tab.groups.map((group) => ({
                ...group,
                pages: Array.isArray(group.pages)
                  ? group.pages.map((entry) => prefixLocalePage(entry, locale.dir))
                  : group.pages,
              }))
            : tab.groups,
        }))
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
  const generatedLanguageSet = new Set(GENERATED_LOCALES.map((entry) => entry.language));
  const withoutGenerated = languages.filter((entry) => !generatedLanguageSet.has(entry?.language));
  const enIndex = withoutGenerated.findIndex((entry) => entry?.language === "en");
  const generated = GENERATED_LOCALES.map((entry) => composeLocaleNav(entry, englishNav));
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

function syncDocsTree(targetRoot) {
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
    ...localeFilters,
    `${SOURCE_DOCS_DIR}/`,
    `${targetDocsDir}/`,
  ]);

  for (const locale of GENERATED_LOCALES) {
    const sourceTmPath = path.join(SOURCE_DOCS_DIR, ".i18n", locale.tmFile);
    const targetTmPath = path.join(targetDocsDir, ".i18n", locale.tmFile);
    if (!fs.existsSync(targetTmPath) && fs.existsSync(sourceTmPath)) {
      ensureDir(path.dirname(targetTmPath));
      fs.copyFileSync(sourceTmPath, targetTmPath);
    }
  }

  writeJson(path.join(targetDocsDir, "docs.json"), composeDocsConfig());
}

function writeSyncMetadata(targetRoot, args) {
  const metadata = {
    repository: args.sourceRepo || "",
    sha: args.sourceSha || "",
    syncedAt: new Date().toISOString(),
  };
  writeJson(path.join(targetRoot, ".openclaw-sync", "source.json"), metadata);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetRoot = path.resolve(args.target);

  if (!fs.existsSync(targetRoot)) {
    throw new Error(`target does not exist: ${targetRoot}`);
  }

  syncDocsTree(targetRoot);
  writeSyncMetadata(targetRoot, args);
}

main();
