import fs from "node:fs";
import path from "node:path";
import {
  commandsLightSourceFiles,
  commandsLightTestFiles,
} from "./vitest.commands-light-paths.mjs";
import { pluginSdkLightSourceFiles, pluginSdkLightTestFiles } from "./vitest.plugin-sdk-paths.mjs";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

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
  "src/markdown/**/*.test.ts",
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
  "src/terminal/**/*.test.ts",
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
  "src/acp/control-plane/manager.test.ts",
  "src/acp/session-mapper.test.ts",
  "src/acp/persistent-bindings.lifecycle.test.ts",
  "src/acp/translator.prompt-prefix.test.ts",
  "src/acp/translator.cancel-scoping.test.ts",
  "src/acp/translator.stop-reason.test.ts",
  "src/acp/persistent-bindings.test.ts",
  "src/acp/server.startup.test.ts",
  "src/acp/translator.session-rate-limit.test.ts",
  "src/acp/translator.set-session-mode.test.ts",
  "src/browser-lifecycle-cleanup.test.ts",
  "src/canvas-host/server.test.ts",
  "src/crestodian/audit.test.ts",
  "src/crestodian/assistant.configured.test.ts",
  "src/crestodian/crestodian.test.ts",
  "src/crestodian/operations.test.ts",
  "src/crestodian/overview.test.ts",
  "src/crestodian/rescue-policy.test.ts",
  "src/crestodian/rescue-message.test.ts",
  "src/crestodian/tui-backend.test.ts",
  "src/flows/channel-setup.test.ts",
  "src/flows/channel-setup.status.test.ts",
  "src/flows/doctor-health-contributions.test.ts",
  "src/flows/provider-flow.test.ts",
  "src/context-engine/context-engine.test.ts",
  "src/canvas-host/server.state-dir.test.ts",
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
  "src/memory-host-sdk/host/backend-config.test.ts",
  "src/media-generation/provider-capabilities.contract.test.ts",
  "src/music-generation/runtime.test.ts",
  "src/mcp/channel-server.shutdown-unhandled-rejection.test.ts",
  "src/mcp/openclaw-tools-serve.test.ts",
  "src/node-host/runner.credentials.test.ts",
  "src/node-host/plugin-node-host.test.ts",
  "src/node-host/invoke-system-run-plan.test.ts",
  "src/node-host/invoke-system-run.test.ts",
  "src/pairing/pairing-challenge.test.ts",
  "src/pairing/allow-from-store-read.test.ts",
  "src/pairing/pairing-store.test.ts",
  "src/pairing/setup-code.test.ts",
  "src/plugin-activation-boundary.test.ts",
  "src/plugin-sdk/memory-host-events.test.ts",
  "src/proxy-capture/env.test.ts",
  "src/proxy-capture/runtime.test.ts",
  "src/proxy-capture/proxy-server.test.ts",
  "src/proxy-capture/store.sqlite.test.ts",
  "src/realtime-voice/agent-consult-runtime.test.ts",
  "src/realtime-voice/session-runtime.test.ts",
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
  "src/security/dm-policy-shared.test.ts",
  "src/security/audit-plugins-trust.test.ts",
  "src/security/audit-plugin-readonly-scope.test.ts",
  "src/security/audit-loopback-logging.test.ts",
  "src/security/audit-workspace-skill-escape.test.ts",
  "src/security/external-content.test.ts",
  "src/security/fix.test.ts",
  "src/security/scan-paths.test.ts",
  "src/security/skill-scanner.test.ts",
  "src/security/audit-config-include-perms.test.ts",
  "src/security/context-visibility.test.ts",
  "src/realtime-transcription/websocket-session.test.ts",
  "src/realtime-voice/agent-consult-tool.test.ts",
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
  "src/ui-app-settings.agents-files-refresh.test.ts",
  "src/terminal/restore.test.ts",
  "src/terminal/table.test.ts",
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
  "src/media-generation/runtime-shared.test.ts",
  "src/music-generation/runtime.test.ts",
  "src/proxy-capture/runtime.test.ts",
  "src/plugins/install.npm-spec.test.ts",
  "src/plugins/contracts/**/*.test.ts",
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
    pattern: /(?:runtime-module-mocks|plugins-cli-test-helpers)/u,
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

const walkedTestFilesByCwd = new Map();

function collectRepoTestFiles(cwd) {
  const normalizedCwd = normalizeRepoPath(cwd);
  const cached = walkedTestFilesByCwd.get(normalizedCwd);
  if (cached) {
    return cached;
  }
  const files = ["src", "packages", "test"]
    .flatMap((directory) => walkFiles(path.join(cwd, directory)))
    .map((file) => normalizeRepoPath(path.relative(cwd, file)));
  walkedTestFilesByCwd.set(normalizedCwd, files);
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
  const discovered = collectRepoTestFiles(cwd).filter(
    (file) =>
      matchesAnyGlob(file, unitFastCandidateGlobs) &&
      !matchesAnyGlob(file, broadUnitFastCandidateSkipGlobs),
  );
  return [
    ...new Set([...discovered, ...unitFastCandidateExactFiles, ...forcedUnitFastTestFiles]),
  ].toSorted((a, b) => a.localeCompare(b));
}

export function collectBroadUnitFastTestCandidates(cwd = process.cwd()) {
  const discovered = collectRepoTestFiles(cwd).filter(
    (file) =>
      matchesAnyGlob(file, broadUnitFastCandidateGlobs) &&
      !matchesAnyGlob(file, broadUnitFastCandidateSkipGlobs),
  );
  return [
    ...new Set([...discovered, ...unitFastCandidateExactFiles, ...forcedUnitFastTestFiles]),
  ].toSorted((a, b) => a.localeCompare(b));
}

const unitFastAnalysisByKey = new Map();

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
  const analysis = candidates.map((file) => {
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
    const forced = forcedUnitFastTestFileSet.has(file);
    return {
      file,
      unitFast: forced || reasons.length === 0,
      forced,
      reasons,
    };
  });
  unitFastAnalysisByKey.set(cacheKey, analysis);
  return analysis;
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
