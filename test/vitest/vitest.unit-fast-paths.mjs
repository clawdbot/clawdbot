import fs from "node:fs";
import path from "node:path";
import {
  commandsLightSourceFiles,
  commandsLightTestFiles,
} from "./vitest.commands-light-paths.mjs";
import { pluginSdkLightSourceFiles, pluginSdkLightTestFiles } from "./vitest.plugin-sdk-paths.mjs";

const normalizeRepoPath = (value) => value.replaceAll("\\", "/");

const unitFastCandidateGlobs = [
  "packages/memory-host-sdk/**/*.test.ts",
  "packages/plugin-package-contract/**/*.test.ts",
  "src/acp/**/*.test.ts",
  "src/agents/**/*.test.ts",
  "src/auto-reply/**/*.test.ts",
  "src/bootstrap/**/*.test.ts",
  "src/channels/**/*.test.ts",
  "src/cli/**/*.test.ts",
  "src/commands/**/*.test.ts",
  "src/config/**/*.test.ts",
  "src/daemon/**/*.test.ts",
  "src/i18n/**/*.test.ts",
  "src/hooks/**/*.test.ts",
  "src/image-generation/**/*.test.ts",
  "src/infra/**/*.test.ts",
  "src/interactive/**/*.test.ts",
  "src/link-understanding/**/*.test.ts",
  "src/logging/**/*.test.ts",
  "src/markdown/**/*.test.ts",
  "src/media/**/*.test.ts",
  "src/media-generation/**/*.test.ts",
  "src/media-understanding/**/*.test.ts",
  "src/memory-host-sdk/**/*.test.ts",
  "src/music-generation/**/*.test.ts",
  "src/node-host/**/*.test.ts",
  "src/plugin-sdk/**/*.test.ts",
  "src/plugins/**/*.test.ts",
  "src/poll-params.test.ts",
  "src/polls.test.ts",
  "src/process/**/*.test.ts",
  "src/routing/**/*.test.ts",
  "src/sessions/**/*.test.ts",
  "src/shared/**/*.test.ts",
  "src/terminal/**/*.test.ts",
  "src/test-utils/**/*.test.ts",
  "src/tasks/**/*.test.ts",
  "src/tts/**/*.test.ts",
  "src/utils/**/*.test.ts",
  "src/video-generation/**/*.test.ts",
  "src/wizard/**/*.test.ts",
  "test/**/*.test.ts",
];
const unitFastCandidateExactFiles = [...pluginSdkLightTestFiles, ...commandsLightTestFiles];
const broadUnitFastCandidateGlobs = [
  "src/**/*.test.ts",
  "packages/**/*.test.ts",
  "test/**/*.test.ts",
];
const broadUnitFastCandidateSkipGlobs = [
  "**/*.e2e.test.ts",
  "**/*.live.test.ts",
  "test/fixtures/**/*.test.ts",
  "test/setup-home-isolation.test.ts",
  "src/agents/sandbox.resolveSandboxContext.test.ts",
  "src/channels/plugins/contracts/**/*.test.ts",
  "src/config/**/*.test.ts",
  "src/gateway/**/*.test.ts",
  "src/media-generation/**/*.contract.test.ts",
  "src/plugins/contracts/**/*.test.ts",
  "src/plugin-sdk/browser-subpaths.test.ts",
  "src/security/**/*.test.ts",
  "src/secrets/**/*.test.ts",
];

const disqualifyingPatterns = [
  {
    code: "jsdom-environment",
    pattern: /@vitest-environment\s+jsdom/u,
  },
  {
    code: "module-mocking",
    pattern: /\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|resetModules)\s*\(/u,
  },
  {
    code: "module-mocking-helper",
    pattern: /runtime-module-mocks/u,
  },
  {
    code: "vitest-mock-api",
    pattern: /\bvi\b/u,
  },
  {
    code: "dynamic-import",
    pattern: /\b(?:await\s+)?import\s*\(/u,
  },
  {
    code: "fake-timers",
    pattern:
      /\bvi\.(?:useFakeTimers|setSystemTime|advanceTimers|runAllTimers|runOnlyPendingTimers)\s*\(/u,
  },
  {
    code: "env-or-global-stub",
    pattern: /\bvi\.(?:stubEnv|stubGlobal|unstubAllEnvs|unstubAllGlobals)\s*\(/u,
  },
  {
    code: "process-env-mutation",
    pattern: /(?:process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])?\s*=|delete\s+process\.env)/u,
  },
  {
    code: "global-mutation",
    pattern: /(?:globalThis|global)\s*\[[^\]]+\]\s*=/u,
  },
  {
    code: "filesystem-state",
    pattern:
      /\b(?:mkdtemp|rmSync|writeFileSync|appendFileSync|mkdirSync|createTemp|makeTempDir|tempDir|tmpdir|node:fs|node:os)\b/u,
  },
  {
    code: "runtime-singleton-state",
    pattern: /\b(?:setActivePluginRegistry|resetPluginRuntimeStateForTest|reset.*ForTest)\s*\(/u,
  },
];

function matchesAnyGlob(file, patterns) {
  return patterns.some((pattern) => path.matchesGlob(file, pattern));
}

function walkFiles(directory, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") {
        continue;
      }
      walkFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(normalizeRepoPath(entryPath));
    }
  }
  return files;
}

export function classifyUnitFastTestFileContent(source) {
  const reasons = [];
  for (const { code, pattern } of disqualifyingPatterns) {
    if (pattern.test(source)) {
      reasons.push(code);
    }
  }
  return reasons;
}

export function collectUnitFastTestCandidates(cwd = process.cwd()) {
  const discovered = ["src", "packages", "test"]
    .flatMap((directory) => walkFiles(path.join(cwd, directory)))
    .map((file) => normalizeRepoPath(path.relative(cwd, file)))
    .filter(
      (file) =>
        matchesAnyGlob(file, unitFastCandidateGlobs) &&
        !matchesAnyGlob(file, broadUnitFastCandidateSkipGlobs),
    );
  return [...new Set([...discovered, ...unitFastCandidateExactFiles])].toSorted((a, b) =>
    a.localeCompare(b),
  );
}

export function collectBroadUnitFastTestCandidates(cwd = process.cwd()) {
  const discovered = ["src", "packages", "test"]
    .flatMap((directory) => walkFiles(path.join(cwd, directory)))
    .map((file) => normalizeRepoPath(path.relative(cwd, file)))
    .filter(
      (file) =>
        matchesAnyGlob(file, broadUnitFastCandidateGlobs) &&
        !matchesAnyGlob(file, broadUnitFastCandidateSkipGlobs),
    );
  return [...new Set([...discovered, ...unitFastCandidateExactFiles])].toSorted((a, b) =>
    a.localeCompare(b),
  );
}

export function collectUnitFastTestFileAnalysis(cwd = process.cwd(), options = {}) {
  const candidates =
    options.scope === "broad"
      ? collectBroadUnitFastTestCandidates(cwd)
      : collectUnitFastTestCandidates(cwd);
  return candidates.map((file) => {
    const absolutePath = path.join(cwd, file);
    let source = "";
    try {
      source = fs.readFileSync(absolutePath, "utf8");
    } catch {
      return {
        file,
        unitFast: false,
        reasons: ["missing-file"],
      };
    }
    const reasons = classifyUnitFastTestFileContent(source);
    return {
      file,
      unitFast: reasons.length === 0,
      reasons,
    };
  });
}

let cachedUnitFastTestFiles = null;
let cachedUnitFastTestFileSet = null;
let cachedSourceToUnitFastTestFile = null;

export function getUnitFastTestFiles() {
  if (cachedUnitFastTestFiles !== null) {
    return cachedUnitFastTestFiles;
  }
  cachedUnitFastTestFiles = collectUnitFastTestFileAnalysis()
    .filter((entry) => entry.unitFast)
    .map((entry) => entry.file);
  return cachedUnitFastTestFiles;
}

function getUnitFastTestFileSet() {
  if (cachedUnitFastTestFileSet !== null) {
    return cachedUnitFastTestFileSet;
  }
  cachedUnitFastTestFileSet = new Set(getUnitFastTestFiles());
  return cachedUnitFastTestFileSet;
}

function getSourceToUnitFastTestFile() {
  if (cachedSourceToUnitFastTestFile !== null) {
    return cachedSourceToUnitFastTestFile;
  }
  const unitFastTestFileSet = getUnitFastTestFileSet();
  cachedSourceToUnitFastTestFile = new Map(
    [...pluginSdkLightSourceFiles, ...commandsLightSourceFiles].flatMap((sourceFile) => {
      const testFile = sourceFile.replace(/\.ts$/u, ".test.ts");
      return unitFastTestFileSet.has(testFile) ? [[sourceFile, testFile]] : [];
    }),
  );
  return cachedSourceToUnitFastTestFile;
}

export function isUnitFastTestFile(file) {
  return getUnitFastTestFileSet().has(normalizeRepoPath(file));
}

export function resolveUnitFastTestIncludePattern(file) {
  const normalized = normalizeRepoPath(file);
  const unitFastTestFileSet = getUnitFastTestFileSet();
  if (unitFastTestFileSet.has(normalized)) {
    return normalized;
  }
  const siblingTestFile = normalized.replace(/\.ts$/u, ".test.ts");
  if (unitFastTestFileSet.has(siblingTestFile)) {
    return siblingTestFile;
  }
  return getSourceToUnitFastTestFile().get(normalized) ?? null;
}
