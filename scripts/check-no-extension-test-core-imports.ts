import fs from "node:fs";
import path from "node:path";
import { collectFilesSync, isCodeFile, relativeToCwd } from "./check-file-utils.js";

type Offender = { file: string; hint: string; line?: number; specifier?: string };

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /["']openclaw\/plugin-sdk["']/,
    hint: "Use openclaw/plugin-sdk/<subpath> instead of the monolithic root entry.",
  },
  {
    pattern: /["']openclaw\/plugin-sdk\/test-utils["']/,
    hint: "Use a focused plugin-sdk test subpath for the public extension test surface.",
  },
  {
    pattern: /["']openclaw\/plugin-sdk\/testing["']/,
    hint: "Use a focused plugin-sdk test subpath instead of the broad compatibility testing barrel.",
  },
  {
    pattern: /["']openclaw\/plugin-sdk\/compat["']/,
    hint: "Use a focused public plugin-sdk subpath instead of compat.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:test-utils\/)[^"']+["']/,
    hint: "Use a documented openclaw/plugin-sdk test subpath for bundled extension test helpers.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:test\/helpers\/plugins\/)[^"']+["']/,
    hint: "Use a documented openclaw/plugin-sdk test subpath instead of repo-only plugin helper bridges.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:test\/helpers\/channels\/)[^"']+["']/,
    hint: "Use openclaw/plugin-sdk/channel-test-helpers or another focused SDK test subpath instead of repo-only channel helper bridges.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:test\/helpers\/media-generation\/)[^"']+["']/,
    hint: "Use openclaw/plugin-sdk/provider-test-contracts or openclaw/plugin-sdk/provider-http-test-mocks instead of repo-only media provider helper bridges.",
  },
  {
    pattern:
      /["'](?:\.\.\/)+(?:test\/helpers\/(?:bundled-channel-entry|envelope-timestamp|pairing-reply)\.(?:js|ts))["']/,
    hint: "Use openclaw/plugin-sdk/channel-test-helpers instead of repo-only channel test helper bridges.",
  },
  {
    pattern:
      /["'](?:\.\.\/)+(?:test\/helpers\/(?:http-test-server|mock-incoming-request|temp-home)\.(?:js|ts))["']/,
    hint: "Use openclaw/plugin-sdk/test-env instead of repo-only environment/network test helper bridges.",
  },
  {
    pattern:
      /["'](?:\.\.\/)+(?:test\/helpers\/(?:bundled-plugin-paths|import-fresh|node-builtin-mocks)\.(?:js|ts))["']/,
    hint: "Use openclaw/plugin-sdk/test-fixtures instead of repo-only generic test helper bridges.",
  },
  {
    pattern:
      /["'](?:\.\.\/)+(?:test\/helpers\/(?:provider-replay-policy|stt-live-audio)\.(?:js|ts))["']/,
    hint: "Use openclaw/plugin-sdk/provider-test-contracts instead of repo-only provider test helper bridges.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:test\/helpers\/)[^"']+["']/,
    hint: "Use a documented openclaw/plugin-sdk test subpath instead of repo-only test helper bridges.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:src\/channels\/plugins\/contracts\/test-helpers\/)[^"']+["']/,
    hint: "Use openclaw/plugin-sdk/channel-test-helpers or another focused SDK test subpath instead of core-only channel contract helpers.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:src\/test-utils\/)[^"']+["']/,
    hint: "Use a documented openclaw/plugin-sdk test subpath for public surfaces.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:src\/plugins\/types\.js)["']/,
    hint: "Use public plugin-sdk/core types or documented plugin-sdk test helpers instead.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:src\/channels\/plugins\/contracts\/test-helpers\.js)["']/,
    hint: "Use openclaw/plugin-sdk/channel-contract-testing for channel contract test helpers.",
  },
];

const STATIC_RELATIVE_MODULE_PATTERN = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
const DYNAMIC_RELATIVE_MODULE_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const MOCK_RELATIVE_MODULE_PATTERN =
  /\bvi\.(?:mock|doMock|unmock|doUnmock)\s*\(\s*["']([^"']+)["']/g;

const RELATIVE_CORE_HINT =
  "Use a focused plugin-sdk test/runtime subpath instead of core internals.";
const ROOT_TEST_SUPPORT_LOCAL_SRC_HINT =
  "Move this helper under the extension's src/test-support tree or expose a narrow test-api/runtime-api surface instead of reaching into private src from package-root test-support.";

// Tombstones for retired repo-only plugin helper bridge files. Keep this list so
// deleted bridges fail loudly if they are recreated instead of using SDK subpaths.
const RETIRED_EXTENSION_TEST_HELPER_BRIDGE_FILES = [
  "test/helpers/plugins/env.ts",
  "test/helpers/plugins/fetch-mock.ts",
  "test/helpers/plugins/frozen-time.ts",
  "test/helpers/plugins/media-understanding.ts",
  "test/helpers/plugins/mock-http-response.ts",
  "test/helpers/plugins/contracts-testkit.ts",
  "test/helpers/plugins/direct-smoke.ts",
  "test/helpers/plugins/directory.ts",
  "test/helpers/plugins/onboard-config.ts",
  "test/helpers/plugins/outbound-delivery.ts",
  "test/helpers/plugins/package-manifest-contract.ts",
  "test/helpers/plugins/plugin-api.ts",
  "test/helpers/plugins/plugin-registration-contract-cases.ts",
  "test/helpers/plugins/plugin-registration-contract.ts",
  "test/helpers/plugins/plugin-registration.ts",
  "test/helpers/plugins/plugin-runtime-mock.ts",
  "test/helpers/plugins/plugin-registry.ts",
  "test/helpers/plugins/provider-auth-contract.ts",
  "test/helpers/plugins/provider-catalog.ts",
  "test/helpers/plugins/provider-contract-suites.ts",
  "test/helpers/plugins/provider-contract.ts",
  "test/helpers/plugins/provider-discovery-contract.ts",
  "test/helpers/plugins/provider-onboard.ts",
  "test/helpers/plugins/provider-registration.ts",
  "test/helpers/plugins/provider-runtime-contract.ts",
  "test/helpers/plugins/provider-usage-fetch.ts",
  "test/helpers/plugins/provider-wizard-contract-suites.ts",
  "test/helpers/plugins/public-artifacts.ts",
  "test/helpers/plugins/public-surface-loader.ts",
  "test/helpers/plugins/runtime-taskflow.ts",
  "test/helpers/plugins/runtime-env.ts",
  "test/helpers/plugins/send-config.ts",
  "test/helpers/plugins/setup-wizard.ts",
  "test/helpers/plugins/start-account-context.ts",
  "test/helpers/plugins/start-account-lifecycle.ts",
  "test/helpers/plugins/status-issues.ts",
  "test/helpers/plugins/stream-hooks.ts",
  "test/helpers/plugins/subagent-hooks.ts",
  "test/helpers/plugins/temp-dir.ts",
  "test/helpers/plugins/temp-home.ts",
  "test/helpers/plugins/tts-contract-suites.ts",
  "test/helpers/plugins/typed-cases.ts",
  "test/helpers/plugins/web-fetch-provider-contract.ts",
  "test/helpers/plugins/web-search-provider-contract.ts",
  "test/helpers/media-generation/dashscope-video-provider.ts",
  "test/helpers/media-generation/provider-capability-assertions.ts",
  "test/helpers/media-generation/provider-http-mocks.ts",
  "test/helpers/bundled-channel-entry.ts",
  "test/helpers/bundled-plugin-paths.ts",
  "test/helpers/envelope-timestamp.ts",
  "test/helpers/http-test-server.ts",
  "test/helpers/import-fresh.ts",
  "test/helpers/mock-incoming-request.ts",
  "test/helpers/node-builtin-mocks.ts",
  "test/helpers/pairing-reply.ts",
  "test/helpers/provider-replay-policy.ts",
  "test/helpers/stt-live-audio.ts",
  "test/helpers/temp-home.ts",
  "test/helpers/agents/auth-profile-runtime-contract.ts",
  "test/helpers/agents/delivery-no-reply-runtime-contract.ts",
  "test/helpers/agents/openclaw-owned-tool-runtime-contract.ts",
  "test/helpers/agents/outcome-fallback-runtime-contract.ts",
  "test/helpers/agents/prompt-overlay-runtime-contract.ts",
  "test/helpers/agents/schema-normalization-runtime-contract.ts",
  "test/helpers/agents/transcript-repair-runtime-contract.ts",
  "test/helpers/sandbox-fixtures.ts",
];

function isExtensionTestFile(filePath: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/u.test(filePath) || /\.e2e\.test\.[cm]?[jt]sx?$/u.test(filePath);
}

function isExtensionTestSupportFile(filePath: string): boolean {
  return (
    (/(?:^|[/\\])test-support(?:[/\\]|$)/u.test(filePath) ||
      /(?:\.|-|_)test-support\.[cm]?[jt]sx?$/u.test(filePath)) &&
    /\.[cm]?[jt]sx?$/u.test(filePath)
  );
}

function collectExtensionTestFiles(rootDir: string): string[] {
  return collectFilesSync(rootDir, {
    includeFile: (filePath) =>
      isExtensionTestFile(filePath) || isExtensionTestSupportFile(filePath),
  });
}

function collectPluginHelperFiles(rootDir: string): string[] {
  return collectFilesSync(rootDir, {
    includeFile: isCodeFile,
  });
}

function lineNumberForOffset(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function resolvesToRepoSrc(filePath: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) {
    return false;
  }
  const resolved = path.resolve(path.dirname(filePath), specifier);
  const repoRelative = path.relative(process.cwd(), resolved).replaceAll(path.sep, "/");
  return repoRelative === "src" || repoRelative.startsWith("src/");
}

function getExtensionRootForFile(filePath: string): string | undefined {
  const relativePath = path.relative(process.cwd(), filePath).replaceAll(path.sep, "/");
  const match = /^extensions\/[^/]+(?:\/|$)/u.exec(relativePath);
  return match ? path.resolve(process.cwd(), match[0]) : undefined;
}

function isRootExtensionTestSupportFile(filePath: string): boolean {
  const relativePath = path.relative(process.cwd(), filePath).replaceAll(path.sep, "/");
  return /^extensions\/[^/]+\/test-support(?:\.[cm]?[jt]sx?|\/)/u.test(relativePath);
}

function resolvesToExtensionLocalSrc(filePath: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) {
    return false;
  }
  const extensionRoot = getExtensionRootForFile(filePath);
  if (!extensionRoot) {
    return false;
  }
  const resolved = path.resolve(path.dirname(filePath), specifier);
  const localSrc = path.join(extensionRoot, "src");
  return resolved === localSrc || resolved.startsWith(`${localSrc}${path.sep}`);
}

function collectRelativeCoreImportOffenders(
  filePath: string,
  content: string,
  opts: { includeDynamic: boolean },
): Offender[] {
  const offenders: Offender[] = [];
  const matches = [
    ...content.matchAll(STATIC_RELATIVE_MODULE_PATTERN),
    ...(opts.includeDynamic ? [...content.matchAll(DYNAMIC_RELATIVE_MODULE_PATTERN)] : []),
    ...content.matchAll(MOCK_RELATIVE_MODULE_PATTERN),
  ];
  for (const match of matches) {
    const specifier = match[1];
    if (!specifier || !resolvesToRepoSrc(filePath, specifier)) {
      continue;
    }
    offenders.push({
      file: filePath,
      hint: RELATIVE_CORE_HINT,
      line: lineNumberForOffset(content, match.index ?? 0),
      specifier,
    });
  }
  return offenders;
}

function collectRootTestSupportLocalSrcImportOffenders(
  filePath: string,
  content: string,
): Offender[] {
  if (!isRootExtensionTestSupportFile(filePath)) {
    return [];
  }
  const offenders: Offender[] = [];
  const matches = [
    ...content.matchAll(STATIC_RELATIVE_MODULE_PATTERN),
    ...content.matchAll(DYNAMIC_RELATIVE_MODULE_PATTERN),
    ...content.matchAll(MOCK_RELATIVE_MODULE_PATTERN),
  ];
  for (const match of matches) {
    const specifier = match[1];
    if (!specifier || !resolvesToExtensionLocalSrc(filePath, specifier)) {
      continue;
    }
    offenders.push({
      file: filePath,
      hint: ROOT_TEST_SUPPORT_LOCAL_SRC_HINT,
      line: lineNumberForOffset(content, match.index ?? 0),
      specifier,
    });
  }
  return offenders;
}

function main() {
  const extensionsDir = path.join(process.cwd(), "extensions");
  const pluginHelpersDir = path.join(process.cwd(), "test/helpers/plugins");
  const retiredChannelHelpersDir = path.join(process.cwd(), "test/helpers/channels");
  const files = collectExtensionTestFiles(extensionsDir);
  const pluginHelperFiles = collectPluginHelperFiles(pluginHelpersDir);
  const retiredChannelHelperFiles = fs.existsSync(retiredChannelHelpersDir)
    ? collectFilesSync(retiredChannelHelpersDir, { includeFile: isCodeFile })
    : [];
  const offenders: Offender[] = [];

  for (const file of retiredChannelHelperFiles) {
    offenders.push({
      file,
      hint: "Keep core channel contract helpers under src/channels/plugins/contracts/test-helpers and public plugin helpers under focused openclaw/plugin-sdk test subpaths.",
    });
  }

  for (const file of RETIRED_EXTENSION_TEST_HELPER_BRIDGE_FILES) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    offenders.push({
      file: filePath,
      hint: "Import the helper directly from a documented openclaw/plugin-sdk testing subpath instead of recreating this bridge.",
    });
  }

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const rule of FORBIDDEN_PATTERNS) {
      if (!rule.pattern.test(content)) {
        continue;
      }
      offenders.push({ file, hint: rule.hint });
      break;
    }
    offenders.push(
      ...collectRelativeCoreImportOffenders(file, content, {
        includeDynamic: true,
      }),
    );
    offenders.push(...collectRootTestSupportLocalSrcImportOffenders(file, content));
  }

  for (const file of pluginHelperFiles) {
    const content = fs.readFileSync(file, "utf8");
    offenders.push(
      ...collectRelativeCoreImportOffenders(file, content, {
        includeDynamic: true,
      }),
    );
  }

  if (offenders.length > 0) {
    console.error(
      "Extension test files and plugin test helpers must stay on public plugin-sdk surfaces.",
    );
    for (const offender of offenders.toSorted((a, b) => a.file.localeCompare(b.file))) {
      const location = offender.line
        ? `${relativeToCwd(offender.file)}:${offender.line}`
        : relativeToCwd(offender.file);
      const specifier = offender.specifier ? ` (${offender.specifier})` : "";
      console.error(`- ${location}${specifier}: ${offender.hint}`);
    }
    process.exit(1);
  }

  console.log(
    `OK: extension test files, support helpers, and plugin test helpers avoid direct core test/internal imports (${files.length} extension files, ${pluginHelperFiles.length} plugin helpers checked).`,
  );
}

main();
