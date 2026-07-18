// Unit-fast test discovery and classification helpers for fast local routing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  commandsLightSourceFiles,
  commandsLightTestFiles,
} from "./vitest.commands-light-paths.mjs";
import { pluginSdkLightSourceFiles, pluginSdkLightTestFiles } from "./vitest.plugin-sdk-paths.mjs";
import { boundaryTestFiles, bundledPluginDependentUnitTestFiles } from "./vitest.unit-paths.mjs";

const normalizeRepoPath = (value) => value.replaceAll("\\", "/");

const unitFastCandidateGlobs = [
  "packages/memory-host-sdk/**/*.test.ts",
  "packages/plugin-package-contract/**/*.test.ts",
  "src/acp/**/*.test.ts",
  "src/agents/**/*.test.ts",
  "src/skills/**/*.test.ts",
  "src/auto-reply/**/*.test.ts",
  "src/bootstrap/**/*.test.ts",
  "src/channels/**/*.test.ts",
  "src/cli/**/*.test.ts",
  "src/commands/**/*.test.ts",
  "src/compat/**/*.test.ts",
  "src/config/**/*.test.ts",
  "src/daemon/**/*.test.ts",
  "src/i18n/**/*.test.ts",
  "src/hooks/**/*.test.ts",
  "src/image-generation/**/*.test.ts",
  "src/infra/**/*.test.ts",
  "src/interactive/**/*.test.ts",
  "src/link-understanding/**/*.test.ts",
  "src/logging/**/*.test.ts",
  "packages/markdown-core/src/**/*.test.ts",
  "packages/media-core/src/**/*.test.ts",
  "packages/terminal-core/src/**/*.test.ts",
  "src/media/**/*.test.ts",
  "src/media-generation/**/*.test.ts",
  "src/media-understanding/**/*.test.ts",
  "src/memory-host-sdk/**/*.test.ts",
  "src/model-catalog/**/*.test.ts",
  "src/music-generation/**/*.test.ts",
  "src/node-host/**/*.test.ts",
  "src/plugin-sdk/**/*.test.ts",
  "src/plugins/**/*.test.ts",
  "src/poll-params.test.ts",
  "src/polls.test.ts",
  "src/process/**/*.test.ts",
  "src/proxy-capture/**/*.test.ts",
  "src/routing/**/*.test.ts",
  "src/sessions/**/*.test.ts",
  "src/shared/**/*.test.ts",
  "src/test-utils/**/*.test.ts",
  "src/tasks/**/*.test.ts",
  "src/tts/**/*.test.ts",
  "src/utils/**/*.test.ts",
  "src/video-generation/**/*.test.ts",
  "src/web/**/*.test.ts",
  "src/wizard/**/*.test.ts",
  "test/**/*.test.ts",
];
export const forcedUnitFastTestFiles = [
  "packages/memory-host-sdk/src/host/batch-http.test.ts",
  "packages/memory-host-sdk/src/host/backend-config.test.ts",
  "packages/memory-host-sdk/src/host/embeddings-remote-fetch.test.ts",
  "packages/memory-host-sdk/src/host/internal.test.ts",
  "packages/memory-host-sdk/src/host/post-json.test.ts",
  "packages/memory-host-sdk/src/host/qmd-process.test.ts",
  "packages/memory-host-sdk/src/host/session-files.test.ts",
  "src/acp/client.test.ts",
  "src/acp/control-plane/manager.backend-failover.test.ts",
  "src/acp/control-plane/manager.failover.test.ts",
  "src/acp/control-plane/manager.runtime-config.test.ts",
  "src/acp/control-plane/manager.runtime-handles.test.ts",
  "src/acp/control-plane/manager.test.ts",
  "src/acp/control-plane/manager.turn-results.test.ts",
  "src/acp/session-mapper.test.ts",
  "src/acp/persistent-bindings.lifecycle.test.ts",
  "src/acp/translator.prompt-prefix.test.ts",
  "src/acp/translator.cancel-scoping.test.ts",
  "src/acp/translator.stop-reason.test.ts",
  "src/acp/persistent-bindings.test.ts",
  "src/acp/server.startup.test.ts",
  "src/acp/translator.final-snapshots.test.ts",
  "src/acp/translator.prompt-size.test.ts",
  "src/acp/translator.replay.test.ts",
  "src/acp/translator.session-config.test.ts",
  "src/acp/translator.session-list.test.ts",
  "src/acp/translator.session-rate-limit.test.ts",
  "src/acp/translator.session-setup.test.ts",
  "src/acp/translator.session-snapshot.test.ts",
  "src/acp/translator.set-session-mode.test.ts",
  "src/acp/translator.tool-streaming.test.ts",
  "src/browser-lifecycle-cleanup.test.ts",
  "extensions/canvas/src/host/server.test.ts",
  "src/system-agent/audit.test.ts",
  "src/system-agent/assistant.configured.test.ts",
  "src/system-agent/system-agent.test.ts",
  "src/system-agent/operations.test.ts",
  "src/system-agent/overview.test.ts",
  "src/system-agent/rescue-policy.test.ts",
  "src/system-agent/rescue-message.test.ts",
  "src/system-agent/tui-backend.test.ts",
  "src/flows/channel-setup.status.test.ts",
  "src/flows/provider-flow.test.ts",
  "src/context-engine/context-engine.test.ts",
  "extensions/canvas/src/host/server.state-dir.test.ts",
  "src/docs/clawhub-plugin-docs.test.ts",
  "src/docs/channel-config-examples.test.ts",
  "src/docs/plugin-doc-examples.test.ts",
  "src/docs/install-cloud-secrets.test.ts",
  "src/docker-build-cache.test.ts",
  "src/docker-image-digests.test.ts",
  "src/dockerfile.test.ts",
  "src/entry.compile-cache.test.ts",
  "src/entry.respawn.test.ts",
  "src/entry.version-fast-path.test.ts",
  "src/entry.test.ts",
  "src/flows/doctor-startup-channel-maintenance.test.ts",
  "src/flows/search-setup.test.ts",
  "src/i18n/registry.test.ts",
  "src/image-generation/openai-compatible-image-provider.test.ts",
  "src/image-generation/provider-registry.test.ts",
  "src/install-sh-version.test.ts",
  "src/logger.test.ts",
  "src/library.test.ts",
  "src/media-generation/provider-capabilities.contract.test.ts",
  "src/music-generation/runtime.test.ts",
  "src/mcp/channel-server.shutdown-unhandled-rejection.test.ts",
  "src/mcp/openclaw-tools-serve.test.ts",
  "src/node-host/plugin-node-host.test.ts",
  "src/node-host/invoke-system-run-plan.test.ts",
  "src/node-host/invoke-system-run.test.ts",
  "src/pairing/pairing-challenge.test.ts",
  "src/pairing/setup-code.test.ts",
  "src/plugin-activation-boundary.test.ts",
  "src/plugin-sdk/memory-host-events.test.ts",
  "src/proxy-capture/env.test.ts",
  "src/proxy-capture/runtime.test.ts",
  "src/proxy-capture/proxy-server.test.ts",
  "src/proxy-capture/store.sqlite.test.ts",
  "src/talk/agent-consult-runtime.test.ts",
  "src/talk/session-runtime.test.ts",
  "src/security/audit-channel-account-metadata.test.ts",
  "src/security/audit-channel-source-config-discord.test.ts",
  "src/security/audit-config-basics.test.ts",
  "src/security/audit-channel-dm-policy.test.ts",
  "src/security/audit-channel-source-config-slack.test.ts",
  "src/security/audit-channel-readonly-resolution.test.ts",
  "src/security/audit-config-symlink.test.ts",
  "src/security/audit-exec-surface.test.ts",
  "src/security/audit-exec-sandbox-host.test.ts",
  "src/security/audit-exec-safe-bins.test.ts",
  "src/security/dangerous-config-flags.test.ts",
  "src/security/audit-extra.sync.test.ts",
  "src/security/audit-filesystem-windows.test.ts",
  "src/security/audit-gateway-exposure.test.ts",
  "src/security/audit-gateway.test.ts",
  "src/security/audit-gateway-auth-selection.test.ts",
  "src/security/audit-gateway-http-auth.test.ts",
  "src/security/audit-gateway-tools-http.test.ts",
  "src/security/audit-hooks-routing.test.ts",
  "src/security/audit-sandbox-docker-config.test.ts",
  "src/security/audit-sandbox-browser.test.ts",
  "src/security/safe-regex.test.ts",
  "src/security/audit-model-hygiene.test.ts",
  "src/security/audit-small-model-risk.test.ts",
  "src/security/audit-node-command-findings.test.ts",
  "src/security/audit-extra.async.test.ts",
  "src/security/audit-probe-failure.test.ts",
  "src/security/audit-plugin-code-safety.test.ts",
  "src/security/audit-summary.test.ts",
  "src/security/audit-synced-folder.test.ts",
  "src/security/audit-trust-model.test.ts",
  "src/channels/message-access/message-access.test.ts",
  "src/security/audit-plugins-trust.test.ts",
  "src/security/audit-plugin-readonly-scope.test.ts",
  "src/security/audit-loopback-logging.test.ts",
  "src/skills/security/workspace-audit.test.ts",
  "src/security/external-content.test.ts",
  "src/security/fix.test.ts",
  "src/security/scan-paths.test.ts",
  "src/skills/security/scanner.test.ts",
  "src/security/audit-config-include-perms.test.ts",
  "src/security/context-visibility.test.ts",
  "src/realtime-transcription/websocket-session.test.ts",
  "src/talk/agent-consult-tool.test.ts",
  "src/routing/resolve-route.test.ts",
  "src/sessions/transcript-events.test.ts",
  "src/status/status-message.test.ts",
  "src/security/windows-acl.test.ts",
  "src/trajectory/cleanup.test.ts",
  "src/trajectory/export.test.ts",
  "src/trajectory/metadata.test.ts",
  "src/trajectory/runtime.test.ts",
  "src/tts/openai-compatible-speech-provider.test.ts",
  "src/tts/tts.test.ts",
  "src/tts/provider-registry.test.ts",
  "src/tts/status-config.test.ts",
  "src/tts/tts-config.test.ts",
  "packages/terminal-core/src/restore.test.ts",
  "packages/terminal-core/src/table.test.ts",
  "src/test-helpers/state-dir-env.test.ts",
  "src/test-utils/env.test.ts",
  "src/test-utils/openclaw-test-state.test.ts",
  "src/test-utils/temp-home.test.ts",
  "src/utils.test.ts",
  "src/version.test.ts",
  "src/video-generation/provider-registry.test.ts",
];
const forcedUnitFastTestFileSet = new Set(forcedUnitFastTestFiles);
const unitFastCandidateExactFiles = [...pluginSdkLightTestFiles, ...commandsLightTestFiles];
const unitFastCandidateExactFileSet = new Set(unitFastCandidateExactFiles);
const unitFastSourceExactFileSet = new Set([
  ...pluginSdkLightSourceFiles,
  ...commandsLightSourceFiles,
]);
const broadUnitFastCandidateGlobs = [
  "src/**/*.test.ts",
  "packages/**/*.test.ts",
  "test/**/*.test.ts",
];
const ownerRoutedUnitTestPatterns = [
  "src/agents/openai-transport-stream.*.test.ts",
  "src/auto-reply/reply/dispatch-from-config.test.ts",
];
const broadUnitFastCandidateSkipGlobs = [
  "**/*.e2e.test.ts",
  "**/*.live.test.ts",
  "test/fixtures/**/*.test.ts",
  "test/setup-home-isolation.test.ts",
  // Explicit bundled ownership outranks content-based discovery. Otherwise extracting
  // a test body can silently move its entry to a config with the wrong mocked setup.
  ...bundledPluginDependentUnitTestFiles,
  // Keep these suites in owner configs even when content-based discovery changes.
  ...ownerRoutedUnitTestPatterns,
  "src/agents/sandbox.resolveSandboxContext.test.ts",
  "src/acp/runtime/session-meta.test.ts",
  "src/channels/plugins/contracts/**/*.test.ts",
  "src/config/**/*.test.ts",
  "src/gateway/**/*.test.ts",
  "src/media-generation/**/*.contract.test.ts",
  "src/media-generation/runtime-shared.test.ts",
  "src/music-generation/runtime.test.ts",
  "src/proxy-capture/runtime.test.ts",
  "src/plugins/install.npm-spec.test.ts",
  "src/plugins/contracts/**/*.test.ts",
  "src/pairing/pairing-store.test.ts",
  "src/plugin-sdk/browser-subpaths.test.ts",
  "src/security/**/*.test.ts",
  "src/secrets/**/*.test.ts",
  "test/helpers/stt-live-audio.test.ts",
  "test/vitest-extensions-config.test.ts",
  "test/vitest-unit-paths.test.ts",
  ...boundaryTestFiles,
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
    pattern: /(?:plugins-cli-test-helpers|manager\.test-helpers)/u,
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

const statefulTestHelperImportPattern =
  /\bfrom\s+["']([^"']*(?:test-support|\.harness)(?:\.js|\.ts)?)["']/gu;
const statefulTestHelperByKey = new Map();

function importsStatefulTestHelper(cwd, file, source) {
  for (const match of source.matchAll(statefulTestHelperImportPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) {
      continue;
    }
    const helperPath = path.join(
      path.dirname(file),
      specifier.endsWith(".js")
        ? `${specifier.slice(0, -3)}.ts`
        : specifier.endsWith(".ts")
          ? specifier
          : `${specifier}.ts`,
    );
    const cacheKey = `${normalizeRepoPath(cwd)}\0${normalizeRepoPath(helperPath)}`;
    let stateful = statefulTestHelperByKey.get(cacheKey);
    if (stateful === undefined) {
      try {
        const helperSource = fs.readFileSync(path.join(cwd, helperPath), "utf8");
        stateful = classifyUnitFastTestFileContent(helperSource).length > 0;
      } catch {
        stateful = false;
      }
      statefulTestHelperByKey.set(cacheKey, stateful);
    }
    if (stateful) {
      return true;
    }
  }
  return false;
}

function matchesAnyGlob(file, patterns) {
  return patterns.some((pattern) => path.matchesGlob(file, pattern));
}

const unitFastCandidateFileByPath = new Map();

function isUnitFastCandidateFile(file) {
  const cached = unitFastCandidateFileByPath.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const candidate =
    forcedUnitFastTestFileSet.has(file) ||
    unitFastCandidateExactFileSet.has(file) ||
    (matchesAnyGlob(file, unitFastCandidateGlobs) &&
      !matchesAnyGlob(file, broadUnitFastCandidateSkipGlobs));
  // Candidate rules are static for the process lifetime; scoped configs overlap heavily.
  unitFastCandidateFileByPath.set(file, candidate);
  return candidate;
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

const walkedTestFilesByCwd = new Map();

function collectRepoTestFilesFromGit(cwd) {
  const result = spawnSync("git", ["ls-files", "--", "src", "packages", "test"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((file) => normalizeRepoPath(file.trim()))
    .filter((file) => file.endsWith(".test.ts"));
}

function collectRepoTestFiles(cwd) {
  const normalizedCwd = normalizeRepoPath(cwd);
  const cached = walkedTestFilesByCwd.get(normalizedCwd);
  if (cached) {
    return cached;
  }
  const files =
    collectRepoTestFilesFromGit(cwd) ??
    ["src", "packages", "test"]
      .flatMap((directory) => walkFiles(path.join(cwd, directory)))
      .map((file) => normalizeRepoPath(path.relative(cwd, file)));
  walkedTestFilesByCwd.set(normalizedCwd, files);
  return files;
}

const unitFastCandidateInventoryByCwd = new Map();

function collectUnitFastCandidateInventory(cwd) {
  const cacheKey = normalizeRepoPath(cwd);
  const cached = unitFastCandidateInventoryByCwd.get(cacheKey);
  if (cached) {
    return cached;
  }
  const inventory = [
    ...new Set([
      ...collectRepoTestFiles(cwd),
      ...unitFastCandidateExactFiles,
      ...forcedUnitFastTestFiles,
    ]),
  ];
  // Git inventory and routing constants are stable for the lifetime of a config process.
  unitFastCandidateInventoryByCwd.set(cacheKey, inventory);
  return inventory;
}

function normalizeScopedDir(dir) {
  const normalized = normalizeRepoPath(dir ?? "").replace(/^\.\/+|\/+$/gu, "");
  return normalized === "." ? "" : normalized;
}

function hasRepoRootPrefix(value) {
  return /^(?:apps|extensions|packages|src|test|ui)(?:\/|$)/u.test(value);
}

function cannotSafelyNarrowIncludePattern(value, dir) {
  return (
    value.startsWith("!") ||
    value.startsWith("./") ||
    /^(?:[A-Za-z]:\/|\/)/u.test(value) ||
    /(?:^|\/)\.\.(?:\/|$)/u.test(value) ||
    (Boolean(dir) && /^[{[(]/u.test(value))
  );
}

function anchorScopedIncludePattern(value, dir) {
  const normalized = normalizeRepoPath(value);
  if (!dir || hasRepoRootPrefix(normalized)) {
    return normalized;
  }
  return `${dir}/${normalized}`;
}

function isFileWithinScope(file, dir) {
  return !dir || file.startsWith(`${dir}/`);
}

function literalGlobPrefix(pattern) {
  const dynamicIndex = pattern.search(/[!?*[{(@+]/u);
  return dynamicIndex < 0 ? pattern : pattern.slice(0, dynamicIndex);
}

function matchesCompiledInclude(file, compiledPatterns) {
  return compiledPatterns.some(
    ({ pattern, prefix }) => file.startsWith(prefix) && path.matchesGlob(file, pattern),
  );
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

const unitFastCandidatesByKey = new Map();

function collectUnitFastCandidates(cwd, scope) {
  const cacheKey = `${normalizeRepoPath(cwd)}\0${scope}`;
  const cached = unitFastCandidatesByKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  const broad = scope === "broad";
  const candidates = collectUnitFastCandidateInventory(cwd)
    .filter((file) => {
      if (!broad) {
        return isUnitFastCandidateFile(file);
      }
      return (
        forcedUnitFastTestFileSet.has(file) ||
        unitFastCandidateExactFileSet.has(file) ||
        (matchesAnyGlob(file, broadUnitFastCandidateGlobs) &&
          !matchesAnyGlob(file, broadUnitFastCandidateSkipGlobs))
      );
    })
    .toSorted((a, b) => a.localeCompare(b));
  // Candidate discovery is immutable for the lifetime of a Vitest/audit process.
  unitFastCandidatesByKey.set(cacheKey, candidates);
  return candidates;
}

export function collectUnitFastTestCandidates(cwd = process.cwd()) {
  return collectUnitFastCandidates(cwd, "default");
}

export function collectBroadUnitFastTestCandidates(cwd = process.cwd()) {
  return collectUnitFastCandidates(cwd, "broad");
}

const unitFastAnalysisByKey = new Map();
const unitFastFileAnalysisByKey = new Map();

function analyzeUnitFastTestFile(cwd, file) {
  const cacheKey = `${normalizeRepoPath(cwd)}\0${file}`;
  const cached = unitFastFileAnalysisByKey.get(cacheKey);
  if (cached) {
    return cached;
  }

  let analysis;
  try {
    const source = fs.readFileSync(path.join(cwd, file), "utf8");
    const reasons = classifyUnitFastTestFileContent(source);
    if (importsStatefulTestHelper(cwd, file, source)) {
      // The helper executes in the importing file's module scope, so its mocks and
      // singleton mutations need the same isolation as stateful code in the test itself.
      reasons.push("stateful-test-helper");
    }
    const forced = forcedUnitFastTestFileSet.has(file);
    analysis = {
      file,
      unitFast: forced || reasons.every((reason) => reason === "stateful-test-helper"),
      forced,
      reasons,
    };
  } catch {
    analysis = {
      file,
      unitFast: false,
      reasons: ["missing-file"],
    };
  }

  // Discovery is a process-start snapshot; default and broad audits overlap heavily.
  unitFastFileAnalysisByKey.set(cacheKey, analysis);
  return analysis;
}

export function collectUnitFastTestFileAnalysis(cwd = process.cwd(), options = {}) {
  const cacheKey = `${normalizeRepoPath(cwd)}\0${options.scope ?? "default"}`;
  const cached = unitFastAnalysisByKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  const candidates =
    options.scope === "broad"
      ? collectBroadUnitFastTestCandidates(cwd)
      : collectUnitFastTestCandidates(cwd);
  const analysis = candidates.map((file) => analyzeUnitFastTestFile(cwd, file));
  unitFastAnalysisByKey.set(cacheKey, analysis);
  return analysis;
}

let cachedUnitFastTestFiles = null;
let cachedUnitFastTestFileSet = null;
let cachedUnitFastIsolatedTestFiles = null;
let cachedUnitFastIsolatedTestFileSet = null;
let cachedUnitFastTimerTestFiles = null;
let cachedUnitFastTimerTestFileSet = null;
const scopedUnitFastTestFilesByKey = new Map();

export function getUnitFastTestFilesForIncludePatterns(includePatterns, options = {}) {
  const cwd = process.cwd();
  const normalizedCwd = normalizeRepoPath(cwd);
  const dir = normalizeScopedDir(options.dir);
  const normalizedPatterns = includePatterns.map(normalizeRepoPath);
  if (normalizedPatterns.some((pattern) => cannotSafelyNarrowIncludePattern(pattern, dir))) {
    // Keep the former full exclusion list when Vitest syntax cannot be safely mapped to repo paths.
    return getUnitFastTestFiles();
  }
  const patterns = [
    ...new Set(normalizedPatterns.map((pattern) => anchorScopedIncludePattern(pattern, dir))),
  ].toSorted((left, right) => left.localeCompare(right));
  const cacheKey = JSON.stringify([normalizedCwd, dir, patterns]);
  const cached = scopedUnitFastTestFilesByKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (patterns.length === 0) {
    scopedUnitFastTestFilesByKey.set(cacheKey, []);
    return [];
  }
  const compiledPatterns = patterns.map((pattern) => ({
    pattern,
    prefix: literalGlobPrefix(pattern),
  }));

  const files = collectUnitFastCandidateInventory(cwd)
    .filter((file) => {
      return (
        isFileWithinScope(file, dir) &&
        matchesCompiledInclude(file, compiledPatterns) &&
        isUnitFastCandidateFile(file)
      );
    })
    .toSorted((a, b) => a.localeCompare(b))
    .filter((file) => analyzeUnitFastTestFile(cwd, file).unitFast);

  // Scoped discovery is a process-start snapshot, matching the full unit-fast inventory cache.
  scopedUnitFastTestFilesByKey.set(cacheKey, files);
  return files;
}

export function getUnitFastTestFiles() {
  if (cachedUnitFastTestFiles !== null) {
    return cachedUnitFastTestFiles;
  }
  cachedUnitFastTestFiles = collectUnitFastTestFileAnalysis()
    .filter((entry) => entry.unitFast)
    .map((entry) => entry.file);
  return cachedUnitFastTestFiles;
}

export function getUnitFastTimerTestFiles() {
  if (cachedUnitFastTimerTestFiles !== null) {
    return cachedUnitFastTimerTestFiles;
  }
  cachedUnitFastTimerTestFiles = collectUnitFastTestFileAnalysis()
    .filter((entry) => entry.unitFast && entry.reasons.includes("fake-timers"))
    .map((entry) => entry.file);
  return cachedUnitFastTimerTestFiles;
}

export function getUnitFastIsolatedTestFiles() {
  if (cachedUnitFastIsolatedTestFiles !== null) {
    return cachedUnitFastIsolatedTestFiles;
  }
  const timerTestFiles = new Set(getUnitFastTimerTestFiles());
  cachedUnitFastIsolatedTestFiles = collectUnitFastTestFileAnalysis()
    .filter(
      (entry) =>
        entry.unitFast &&
        !timerTestFiles.has(entry.file) &&
        (entry.forced || entry.reasons.includes("stateful-test-helper")),
    )
    .map((entry) => entry.file);
  return cachedUnitFastIsolatedTestFiles;
}

function getUnitFastTestFileSet() {
  if (cachedUnitFastTestFileSet !== null) {
    return cachedUnitFastTestFileSet;
  }
  cachedUnitFastTestFileSet = new Set(getUnitFastTestFiles());
  return cachedUnitFastTestFileSet;
}

function getUnitFastTimerTestFileSet() {
  if (cachedUnitFastTimerTestFileSet !== null) {
    return cachedUnitFastTimerTestFileSet;
  }
  cachedUnitFastTimerTestFileSet = new Set(getUnitFastTimerTestFiles());
  return cachedUnitFastTimerTestFileSet;
}

function getUnitFastIsolatedTestFileSet() {
  if (cachedUnitFastIsolatedTestFileSet !== null) {
    return cachedUnitFastIsolatedTestFileSet;
  }
  cachedUnitFastIsolatedTestFileSet = new Set(getUnitFastIsolatedTestFiles());
  return cachedUnitFastIsolatedTestFileSet;
}

function isUnitFastTestFileOnDemand(file, cwd = process.cwd()) {
  const normalized = normalizeRepoPath(file);
  if (!isUnitFastCandidateFile(normalized)) {
    return false;
  }
  return analyzeUnitFastTestFile(cwd, normalized).unitFast;
}

export function isUnitFastTestFile(file) {
  return getUnitFastTestFileSet().has(normalizeRepoPath(file));
}

export function isUnitFastTimerTestFile(file) {
  return getUnitFastTimerTestFileSet().has(normalizeRepoPath(file));
}

export function isUnitFastIsolatedTestFile(file) {
  return getUnitFastIsolatedTestFileSet().has(normalizeRepoPath(file));
}

export function resolveUnitFastTestIncludePattern(file) {
  const normalized = normalizeRepoPath(file);
  if (isUnitFastTimerTestFile(normalized)) {
    return null;
  }
  if (isUnitFastIsolatedTestFile(normalized)) {
    return null;
  }
  if (isUnitFastTestFileOnDemand(normalized)) {
    return normalized;
  }
  const siblingTestFile = normalized.replace(/\.ts$/u, ".test.ts");
  if (isUnitFastTimerTestFile(siblingTestFile)) {
    return null;
  }
  if (isUnitFastIsolatedTestFile(siblingTestFile)) {
    return null;
  }
  if (isUnitFastTestFileOnDemand(siblingTestFile)) {
    return siblingTestFile;
  }
  if (unitFastSourceExactFileSet.has(normalized)) {
    const exactTestFile = normalized.replace(/\.ts$/u, ".test.ts");
    return isUnitFastTestFileOnDemand(exactTestFile) ? exactTestFile : null;
  }
  return null;
}

export function resolveUnitFastTimerTestIncludePattern(file) {
  const normalized = normalizeRepoPath(file);
  if (isUnitFastTimerTestFile(normalized)) {
    return normalized;
  }
  const siblingTestFile = normalized.replace(/\.ts$/u, ".test.ts");
  return isUnitFastTimerTestFile(siblingTestFile) ? siblingTestFile : null;
}

export function resolveUnitFastIsolatedTestIncludePattern(file) {
  const normalized = normalizeRepoPath(file);
  if (isUnitFastIsolatedTestFile(normalized)) {
    return normalized;
  }
  const siblingTestFile = normalized.replace(/\.ts$/u, ".test.ts");
  return isUnitFastIsolatedTestFile(siblingTestFile) ? siblingTestFile : null;
}
