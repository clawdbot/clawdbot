import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BaseProbeResult as ContractBaseProbeResult,
  BaseTokenResolution as ContractBaseTokenResolution,
  ChannelAgentTool as ContractChannelAgentTool,
  ChannelAccountSnapshot as ContractChannelAccountSnapshot,
  ChannelGroupContext as ContractChannelGroupContext,
  ChannelMessageActionAdapter as ContractChannelMessageActionAdapter,
  ChannelMessageActionContext as ContractChannelMessageActionContext,
  ChannelMessageActionName as ContractChannelMessageActionName,
  ChannelMessageToolDiscovery as ContractChannelMessageToolDiscovery,
  ChannelStatusIssue as ContractChannelStatusIssue,
  ChannelThreadingContext as ContractChannelThreadingContext,
  ChannelThreadingToolContext as ContractChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type {
  ChannelMessageActionContext as CoreChannelMessageActionContext,
  OpenClawPluginApi as CoreOpenClawPluginApi,
  PluginRuntime as CorePluginRuntime,
} from "openclaw/plugin-sdk/core";
import * as providerEntrySdk from "openclaw/plugin-sdk/provider-entry";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChannelMessageActionContext } from "../../channels/plugins/types.js";
import type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelAgentTool,
  ChannelAccountSnapshot,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelStatusIssue,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type {
  ChannelMessageActionContext as SharedChannelMessageActionContext,
  OpenClawPluginApi as SharedOpenClawPluginApi,
  PluginRuntime as SharedPluginRuntime,
} from "../../plugin-sdk/channel-plugin-common.js";
import { pluginSdkSubpaths } from "../../plugin-sdk/entrypoints.js";
import type { PluginRuntime } from "../runtime/types.js";
import type { OpenClawPluginApi } from "../types.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const PLUGIN_SDK_DIR = resolve(SRC_ROOT, "plugin-sdk");
const sourceCache = new Map<string, string>();
const repoTsFilesCache = new Map<string, string[]>();
const representativeRuntimeSmokeSubpaths = ["channel-runtime", "conversation-runtime"] as const;

const importResolvedPluginSdkSubpath = async (specifier: string) => import(specifier);

type BrowserFacadeSourceContract = {
  subpath: string;
  artifactBasename: string;
  mentions: readonly string[];
  omits: readonly string[];
};

type BrowserHelperExportParityContract = {
  corePath: string;
  extensionPath: string;
  expectedExports: readonly string[];
};

const BROWSER_FACADE_SOURCE_CONTRACTS: readonly BrowserFacadeSourceContract[] = [
  {
    subpath: "browser-control-auth",
    artifactBasename: "browser-control-auth.js",
    mentions: [
      "loadBundledPluginPublicSurfaceModuleSync",
      "resolveBrowserControlAuth",
      "shouldAutoGenerateBrowserAuth",
      "ensureBrowserControlAuth",
    ],
    omits: [
      "resolveGatewayAuth",
      "writeConfigFile",
      "generateBrowserControlToken",
      "ensureGatewayStartupAuth",
    ],
  },
  {
    subpath: "browser-profiles",
    artifactBasename: "browser-profiles.js",
    mentions: [
      "loadBundledPluginPublicSurfaceModuleSync",
      "resolveBrowserConfig",
      "resolveProfile",
    ],
    omits: [
      "resolveBrowserSsrFPolicy",
      "ensureDefaultProfile",
      "ensureDefaultUserBrowserProfile",
      "normalizeHexColor",
    ],
  },
  {
    subpath: "browser-host-inspection",
    artifactBasename: "browser-host-inspection.js",
    mentions: [
      "loadBundledPluginPublicSurfaceModuleSync",
      "resolveGoogleChromeExecutableForPlatform",
      "readBrowserVersion",
      "parseBrowserMajorVersion",
    ],
    omits: ["findFirstChromeExecutable", "findGoogleChromeExecutableLinux", "execText"],
  },
];

const BROWSER_HELPER_EXPORT_PARITY_CONTRACTS: readonly BrowserHelperExportParityContract[] = [
  {
    corePath: "src/plugin-sdk/browser-control-auth.ts",
    extensionPath: "extensions/browser/browser-control-auth.ts",
    expectedExports: [
      "BrowserControlAuth",
      "ensureBrowserControlAuth",
      "resolveBrowserControlAuth",
      "shouldAutoGenerateBrowserAuth",
    ],
  },
  {
    corePath: "src/plugin-sdk/browser-profiles.ts",
    extensionPath: "extensions/browser/browser-profiles.ts",
    expectedExports: [
      "DEFAULT_AI_SNAPSHOT_MAX_CHARS",
      "DEFAULT_BROWSER_DEFAULT_PROFILE_NAME",
      "DEFAULT_BROWSER_EVALUATE_ENABLED",
      "DEFAULT_OPENCLAW_BROWSER_COLOR",
      "DEFAULT_OPENCLAW_BROWSER_ENABLED",
      "DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME",
      "DEFAULT_UPLOAD_DIR",
      "ResolvedBrowserConfig",
      "ResolvedBrowserProfile",
      "resolveBrowserConfig",
      "resolveProfile",
    ],
  },
  {
    corePath: "src/plugin-sdk/browser-host-inspection.ts",
    extensionPath: "extensions/browser/browser-host-inspection.ts",
    expectedExports: [
      "BrowserExecutable",
      "parseBrowserMajorVersion",
      "readBrowserVersion",
      "resolveGoogleChromeExecutableForPlatform",
    ],
  },
];

function readCachedSource(absolutePath: string): string {
  const cached = sourceCache.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }
  const text = readFileSync(absolutePath, "utf8");
  sourceCache.set(absolutePath, text);
  return text;
}

function readPluginSdkSource(subpath: string): string {
  return readCachedSource(resolve(PLUGIN_SDK_DIR, `${subpath}.ts`));
}

function readRepoSource(relativePath: string): string {
  return readCachedSource(resolve(REPO_ROOT, relativePath));
}

function collectNamedExportsFromClause(clause: string): string[] {
  return clause
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/^type\s+/u, ""))
    .map((segment) => {
      const aliasMatch = segment.match(/\s+as\s+([A-Za-z_$][\w$]*)$/u);
      if (aliasMatch?.[1]) {
        return aliasMatch[1];
      }
      return segment;
    });
}

function collectNamedExportsFromSource(source: string): string[] {
  const names = new Set<string>();

  const exportClausePattern =
    /export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s+["'][^"']+["'])?\s*;?/gms;
  for (const match of source.matchAll(exportClausePattern)) {
    for (const name of collectNamedExportsFromClause(match[1] ?? "")) {
      names.add(name);
    }
  }

  for (const pattern of [
    /\bexport\s+(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu,
    /\bexport\s+(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)/gu,
    /\bexport\s+type\s+([A-Za-z_$][\w$]*)\s*=/gu,
    /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/gu,
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/gu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        names.add(match[1]);
      }
    }
  }

  return [...names].toSorted();
}

function collectNamedExportsFromRepoFile(relativePath: string): string[] {
  return collectNamedExportsFromSource(readRepoSource(relativePath));
}

function expectNamedExportParity(params: BrowserHelperExportParityContract) {
  const coreExports = collectNamedExportsFromRepoFile(params.corePath);
  const extensionExports = collectNamedExportsFromRepoFile(params.extensionPath);
  expect(coreExports, `${params.corePath} exports changed`).toEqual([...params.expectedExports]);
  expect(extensionExports, `${params.extensionPath} exports changed`).toEqual([
    ...params.expectedExports,
  ]);
}

function listRepoTsFiles(dir: string): string[] {
  const cached = repoTsFilesCache.get(dir);
  if (cached) {
    return cached;
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = entries.flatMap((entry) => {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        return [];
      }
      return listRepoTsFiles(absolute);
    }
    if (!entry.isFile()) {
      return [];
    }
    return absolute.endsWith(".ts") ? [absolute] : [];
  });
  repoTsFilesCache.set(dir, files);
  return files;
}

function findRepoFilesContaining(params: {
  roots: readonly string[];
  pattern: RegExp;
  exclude?: readonly string[];
  excludeFilesMatching?: readonly RegExp[];
}) {
  const excluded = new Set((params.exclude ?? []).map((entry) => resolve(REPO_ROOT, entry)));
  return params.roots
    .flatMap((root) => listRepoTsFiles(root))
    .filter((file) => !excluded.has(file))
    .filter((file) => !(params.excludeFilesMatching ?? []).some((pattern) => pattern.test(file)))
    .filter((file) => params.pattern.test(readCachedSource(file)))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .toSorted();
}

function isIdentifierCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 36 ||
    code === 95
  );
}

function sourceMentionsIdentifier(source: string, name: string): boolean {
  let fromIndex = 0;
  while (true) {
    const matchIndex = source.indexOf(name, fromIndex);
    if (matchIndex === -1) {
      return false;
    }
    const beforeCode = matchIndex === 0 ? -1 : source.charCodeAt(matchIndex - 1);
    const afterIndex = matchIndex + name.length;
    const afterCode = afterIndex >= source.length ? -1 : source.charCodeAt(afterIndex);
    if (!isIdentifierCode(beforeCode) && !isIdentifierCode(afterCode)) {
      return true;
    }
    fromIndex = matchIndex + 1;
  }
}

function expectSourceMentions(subpath: string, names: readonly string[]) {
  const source = readPluginSdkSource(subpath);
  const missing = names.filter((name) => !sourceMentionsIdentifier(source, name));
  expect(missing, `${subpath} missing exports`).toEqual([]);
}

function expectSourceOmits(subpath: string, names: readonly string[]) {
  const source = readPluginSdkSource(subpath);
  const present = names.filter((name) => sourceMentionsIdentifier(source, name));
  expect(present, `${subpath} leaked exports`).toEqual([]);
}

function expectSourceContract(
  subpath: string,
  params: { mentions?: readonly string[]; omits?: readonly string[] },
) {
  const source = readPluginSdkSource(subpath);
  const missing = (params.mentions ?? []).filter((name) => !sourceMentionsIdentifier(source, name));
  const present = (params.omits ?? []).filter((name) => sourceMentionsIdentifier(source, name));
  expect(missing, `${subpath} missing exports`).toEqual([]);
  expect(present, `${subpath} leaked exports`).toEqual([]);
}

function expectSourceContains(subpath: string, snippet: string) {
  expect(readPluginSdkSource(subpath)).toContain(snippet);
}

function expectSourceOmitsSnippet(subpath: string, snippet: string) {
  expect(readPluginSdkSource(subpath)).not.toContain(snippet);
}

function expectSourceOmitsImportPattern(subpath: string, specifier: string) {
  const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = readPluginSdkSource(subpath);
  expect(source).not.toMatch(new RegExp(`\\bfrom\\s+["']${escapedSpecifier}["']`, "u"));
  expect(source).not.toMatch(new RegExp(`\\bimport\\(\\s*["']${escapedSpecifier}["']\\s*\\)`, "u"));
}

function expectBrowserFacadeSourceContract(contract: BrowserFacadeSourceContract) {
  expectSourceMentions(contract.subpath, contract.mentions);
  expectSourceContains(contract.subpath, `artifactBasename: "${contract.artifactBasename}"`);
  expectSourceOmits(contract.subpath, contract.omits);
}

function isGeneratedBundledFacadeSubpath(subpath: string): boolean {
  const source = readPluginSdkSource(subpath);
  return (
    source.startsWith("// Manual facade.") &&
    sourceMentionsIdentifier(source, "loadBundledPluginPublicSurfaceModuleSync")
  );
}

describe("plugin-sdk subpath exports", () => {
  it("keeps the curated public list free of internal implementation subpaths", () => {
    for (const deniedSubpath of [
      "acpx",
      "device-pair",
      "lobster",
      "pairing-access",
      "provider-model-definitions",
      "reply-prefix",
      "secret-input-schema",
      "signal-core",
      "synology-chat",
      "typing",
      "whatsapp",
      "whatsapp-action-runtime",
      "whatsapp-login-qr",
      "zai",
    ]) {
      expect(pluginSdkSubpaths).not.toContain(deniedSubpath);
    }
  });

  it("keeps removed bundled-channel aliases out of the public sdk list", () => {
    const removedChannelAliases = new Set(["discord", "signal", "slack", "telegram", "whatsapp"]);
    const banned = pluginSdkSubpaths.filter((subpath) => removedChannelAliases.has(subpath));
    expect(banned).toEqual([]);
  });

  it("keeps generated bundled-channel facades out of the public sdk list", () => {
    const bannedPrefixes = ["discord", "signal", "slack", "telegram", "whatsapp"];
    const banned = pluginSdkSubpaths.filter((subpath) =>
      bannedPrefixes.some(
        (prefix) =>
          (subpath === prefix ||
            subpath.startsWith(`${prefix}-`) ||
            subpath.startsWith(`${prefix}.`)) &&
          isGeneratedBundledFacadeSubpath(subpath),
      ),
    );
    expect(banned).toEqual([]);
  });

  it("keeps browser compatibility helper subpaths as thin facades", () => {
    for (const contract of BROWSER_FACADE_SOURCE_CONTRACTS) {
      expectBrowserFacadeSourceContract(contract);
    }
  });

  it("keeps browser helper facade exports aligned with extension public wrappers", () => {
    for (const contract of BROWSER_HELPER_EXPORT_PARITY_CONTRACTS) {
      expectNamedExportParity(contract);
    }
  });

  it("keeps helper subpaths aligned", () => {
    expectSourceMentions("core", [
      "emptyPluginConfigSchema",
      "definePluginEntry",
      "defineChannelPluginEntry",
      "defineSetupPluginEntry",
      "createChatChannelPlugin",
      "createChannelPluginBase",
      "isSecretRef",
      "optionalStringEnum",
    ]);
    expectSourceOmits("core", [
      "runPassiveAccountLifecycle",
      "createLoggerBackedRuntime",
      "registerSandboxBackend",
    ]);
    expectSourceContract("routing", {
      mentions: [
        "buildAgentSessionKey",
        "resolveThreadSessionKeys",
        "normalizeMessageChannel",
        "resolveGatewayMessageChannel",
      ],
    });
    expectSourceMentions("reply-payload", [
      "buildMediaPayload",
      "deliverTextOrMediaReply",
      "resolveOutboundMediaUrls",
      "resolvePayloadMediaUrls",
      "sendPayloadMediaSequenceAndFinalize",
      "sendPayloadMediaSequenceOrFallback",
      "sendTextMediaPayload",
      "sendPayloadWithChunkedTextAndMedia",
    ]);
    expectSourceMentions("media-runtime", [
      "createDirectTextMediaOutbound",
      "createScopedChannelMediaMaxBytesResolver",
    ]);
    expectSourceMentions("bluebubbles", [
      "normalizeBlueBubblesAcpConversationId",
      "matchBlueBubblesAcpConversation",
      "resolveBlueBubblesConversationIdFromTarget",
      "resolveAckReaction",
      "resolveChannelMediaMaxBytes",
      "collectBlueBubblesStatusIssues",
      "createChannelPairingController",
      "createChannelReplyPipeline",
      "resolveRequestUrl",
      "buildProbeChannelStatusSummary",
      "extractToolSend",
      "createFixedWindowRateLimiter",
      "withResolvedWebhookRequestPipeline",
    ]);
    expectSourceMentions("irc", [
      "createChannelReplyPipeline",
      "chunkTextForOutbound",
      "createChannelPairingController",
      "createLoggerBackedRuntime",
      "ircSetupAdapter",
      "ircSetupWizard",
    ]);
    expectSourceMentions("bluebubbles-policy", [
      "isAllowedBlueBubblesSender",
      "resolveBlueBubblesGroupRequireMention",
      "resolveBlueBubblesGroupToolPolicy",
    ]);
    for (const subpath of [
      "feishu",
      "googlechat",
      "matrix",
      "mattermost",
      "msteams",
      "zalo",
      "zalouser",
    ]) {
      expectSourceMentions(subpath, ["chunkTextForOutbound"]);
    }
    for (const subpath of ["googlechat", "msteams", "nextcloud-talk", "zalouser"]) {
      expectSourceMentions(subpath, [
        "resolveInboundMentionDecision",
        "resolveMentionGating",
        "resolveMentionGatingWithBypass",
      ]);
    }
    expectSourceMentions("approval-auth-runtime", [
      "createResolvedApproverActionAuthAdapter",
      "resolveApprovalApprovers",
    ]);
    expectSourceMentions("reply-chunking", ["chunkText", "chunkTextWithMode"]);
    expectSourceMentions("reply-history", [
      "buildPendingHistoryContextFromMap",
      "clearHistoryEntriesIfEnabled",
      "recordPendingHistoryEntryIfEnabled",
    ]);
    expectSourceContract("reply-runtime", {
      omits: [
        "buildPendingHistoryContextFromMap",
        "clearHistoryEntriesIfEnabled",
        "recordPendingHistoryEntryIfEnabled",
        "DEFAULT_GROUP_HISTORY_LIMIT",
      ],
    });
    expectSourceMentions("account-helpers", ["createAccountListHelpers"]);
    expectSourceMentions("channel-actions", ["optionalStringEnum", "stringEnum"]);
    expectSourceContract("channel-secret-basic-runtime", {
      mentions: [
        "collectSimpleChannelFieldAssignments",
        "collectConditionalChannelFieldAssignments",
        "collectSecretInputAssignment",
        "getChannelSurface",
        "pushAssignment",
        "pushInactiveSurfaceWarning",
        "ResolverContext",
        "SecretTargetRegistryEntry",
      ],
      omits: ["collectNestedChannelTtsAssignments"],
    });
    expectSourceContract("channel-secret-runtime", {
      mentions: [
        "collectSimpleChannelFieldAssignments",
        "collectConditionalChannelFieldAssignments",
        "collectSecretInputAssignment",
        "getChannelSurface",
        "pushAssignment",
        "pushInactiveSurfaceWarning",
        "ResolverContext",
        "SecretTargetRegistryEntry",
      ],
      omits: [
        "buildUntrustedChannelMetadata",
        "evaluateSupplementalContextVisibility",
        "resolvePinnedMainDmOwnerFromAllowlist",
        "safeMatchRegex",
      ],
    });
    expectSourceContract("channel-secret-tts-runtime", {
      mentions: ["collectNestedChannelTtsAssignments"],
      omits: ["collectSimpleChannelFieldAssignments", "collectConditionalChannelFieldAssignments"],
    });
    expectSourceContract("provider-web-search-contract", {
      mentions: [
        "createWebSearchProviderContractFields",
        "enablePluginInConfig",
        "getScopedCredentialValue",
        "resolveProviderWebSearchPluginConfig",
        "setScopedCredentialValue",
        "setProviderWebSearchPluginConfigValue",
        "WebSearchProviderPlugin",
      ],
      omits: [
        "buildSearchCacheKey",
        "withTrustedWebSearchEndpoint",
        "writeCachedSearchPayload",
        "resolveCitationRedirectUrl",
      ],
    });
    expectSourceContract("provider-web-search-config-contract", {
      mentions: [
        "getScopedCredentialValue",
        "resolveProviderWebSearchPluginConfig",
        "setScopedCredentialValue",
        "setProviderWebSearchPluginConfigValue",
        "WebSearchProviderPlugin",
      ],
      omits: [
        "enablePluginInConfig",
        "buildSearchCacheKey",
        "withTrustedWebSearchEndpoint",
        "writeCachedSearchPayload",
        "resolveCitationRedirectUrl",
      ],
    });
    expectSourceContract("provider-web-fetch-contract", {
      mentions: ["enablePluginInConfig", "WebFetchProviderPlugin"],
      omits: [
        "withTrustedWebToolsEndpoint",
        "readResponseText",
        "resolveCacheTtlMs",
        "wrapExternalContent",
      ],
    });
    expectSourceContract("tool-payload", {
      mentions: ["extractToolPayload", "ToolPayloadCarrier"],
      omits: ["createAnthropicToolPayloadCompatibilityWrapper", "extractToolSend"],
    });
    expectSourceMentions("compat", [
      "createPluginRuntimeStore",
      "createScopedChannelConfigAdapter",
      "resolveControlCommandGate",
      "delegateCompactionToRuntime",
    ]);
    expectSourceMentions("device-bootstrap", [
      "approveDevicePairing",
      "issueDeviceBootstrapToken",
      "listDevicePairing",
    ]);
    expectSourceMentions("allowlist-config-edit", [
      "buildDmGroupAccountAllowlistAdapter",
      "createNestedAllowlistOverrideResolver",
    ]);
    expectSourceContract("allow-from", {
      mentions: [
        "addAllowlistUserEntriesFromConfigEntry",
        "buildAllowlistResolutionSummary",
        "canonicalizeAllowlistWithResolvedIds",
        "mapAllowlistResolutionInputs",
        "mergeAllowlist",
        "patchAllowlistUsersInConfigEntries",
        "summarizeMapping",
        "compileAllowlist",
        "firstDefined",
        "formatAllowlistMatchMeta",
        "isSenderIdAllowed",
        "mergeDmAllowFromSources",
        "resolveAllowlistMatchSimple",
      ],
    });
    expectSourceMentions("runtime", ["createLoggerBackedRuntime"]);
    expectSourceMentions("conversation-runtime", [
      "recordInboundSession",
      "recordInboundSessionMetaSafe",
      "resolveConversationLabel",
    ]);
    expectSourceMentions("directory-runtime", [
      "createChannelDirectoryAdapter",
      "createRuntimeDirectoryLiveAdapter",
      "listDirectoryEntriesFromSources",
      "listResolvedDirectoryEntriesFromSources",
    ]);
    expectSourceContains(
      "memory-core-host-runtime-core",
      'export * from "../memory-host-sdk/runtime-core.js";',
    );
    expectSourceContains(
      "memory-core-host-runtime-cli",
      'export * from "../memory-host-sdk/runtime-cli.js";',
    );
    expectSourceContains(
      "memory-core-host-runtime-files",
      'export * from "../memory-host-sdk/runtime-files.js";',
    );
  });

  it("keeps the deprecated channel-runtime shim unused in repo imports", () => {
    const matches = findRepoFilesContaining({
      roots: [
        resolve(REPO_ROOT, "src"),
        resolve(REPO_ROOT, "extensions"),
        resolve(REPO_ROOT, "test"),
      ],
      pattern: /openclaw\/plugin-sdk\/channel-runtime(?=["'])/u,
      exclude: [
        "src/plugins/sdk-alias.test.ts",
        "src/plugins/contracts/plugin-sdk-root-alias.test.ts",
      ],
    });
    expect(matches).toEqual([]);
  });

  it("keeps removed channel-named runtime boundaries out of core imports", () => {
    const matches = findRepoFilesContaining({
      roots: [resolve(REPO_ROOT, "src")],
      pattern:
        /plugins\/runtime\/runtime-(?:discord|imessage|line|signal|slack|telegram|whatsapp)(?:[-.][^"']*)?\.js/u,
      exclude: [
        "src/plugins/runtime/runtime-plugin-boundary.ts",
        "src/plugins/runtime/runtime-web-channel-plugin.ts",
      ],
      excludeFilesMatching: [/\.test\.ts$/u, /\.test-harness\.ts$/u],
    });
    expect(matches).toEqual([]);
  });

  it("exports channel runtime helpers from the dedicated subpath", () => {
    expectSourceOmits("channel-runtime", [
      "applyChannelMatchMeta",
      "createChannelDirectoryAdapter",
      "createEmptyChannelDirectoryAdapter",
      "createArmableStallWatchdog",
      "createDraftStreamLoop",
      "createLoggedPairingApprovalNotifier",
      "createPairingPrefixStripper",
      "createRunStateMachine",
      "createRuntimeDirectoryLiveAdapter",
      "createRuntimeOutboundDelegates",
      "createStatusReactionController",
      "createTextPairingAdapter",
      "createFinalizableDraftLifecycle",
      "DEFAULT_EMOJIS",
      "logAckFailure",
      "logTypingFailure",
      "logInboundDrop",
      "normalizeMessageChannel",
      "removeAckReactionAfterReply",
      "recordInboundSession",
      "recordInboundSessionMetaSafe",
      "resolveInboundSessionEnvelopeContext",
      "resolveInboundMentionDecision",
      "resolveMentionGating",
      "resolveMentionGatingWithBypass",
      "resolveOutboundSendDep",
      "resolveConversationLabel",
      "shouldDebounceTextInbound",
      "shouldAckReaction",
      "shouldAckReactionForWhatsApp",
      "toLocationContext",
      "resolveThreadBindingConversationIdFromBindingId",
      "resolveThreadBindingEffectiveExpiresAt",
      "resolveThreadBindingFarewellText",
      "resolveThreadBindingIdleTimeoutMs",
      "resolveThreadBindingIdleTimeoutMsForChannel",
      "resolveThreadBindingIntroText",
      "resolveThreadBindingLifecycle",
      "resolveThreadBindingMaxAgeMs",
      "resolveThreadBindingMaxAgeMsForChannel",
      "resolveThreadBindingSpawnPolicy",
      "resolveThreadBindingThreadName",
      "resolveThreadBindingsEnabled",
      "formatThreadBindingDisabledError",
      "resolveControlCommandGate",
      "resolveCommandAuthorizedFromAuthorizers",
      "resolveDualTextControlCommandGate",
      "resolveNativeCommandSessionTargets",
      "attachChannelToResult",
      "buildComputedAccountStatusSnapshot",
      "buildMediaPayload",
      "createActionGate",
      "jsonResult",
      "normalizeInteractiveReply",
      "PAIRING_APPROVED_MESSAGE",
      "projectCredentialSnapshotFields",
      "readStringParam",
      "compileAllowlist",
      "formatAllowlistMatchMeta",
      "firstDefined",
      "isSenderIdAllowed",
      "mergeDmAllowFromSources",
      "addAllowlistUserEntriesFromConfigEntry",
      "buildAllowlistResolutionSummary",
      "canonicalizeAllowlistWithResolvedIds",
      "mergeAllowlist",
      "patchAllowlistUsersInConfigEntries",
      "resolvePayloadMediaUrls",
      "resolveScopedChannelMediaMaxBytes",
      "sendPayloadMediaSequenceAndFinalize",
      "sendPayloadMediaSequenceOrFallback",
      "sendTextMediaPayload",
      "createScopedChannelMediaMaxBytesResolver",
      "runPassiveAccountLifecycle",
      "buildChannelKeyCandidates",
      "buildMessagingTarget",
      "createDirectTextMediaOutbound",
      "createMessageToolButtonsSchema",
      "createMessageToolCardSchema",
      "createScopedAccountReplyToModeResolver",
      "createStaticReplyToModeResolver",
      "createTopLevelChannelReplyToModeResolver",
      "createUnionActionGate",
      "ensureTargetId",
      "listTokenSourcedAccounts",
      "parseMentionPrefixOrAtUserTarget",
      "requireTargetKind",
      "resolveChannelEntryMatchWithFallback",
      "resolveChannelMatchConfig",
      "resolveReactionMessageId",
      "resolveTargetsWithOptionalToken",
      "appendMatchMetadata",
      "asString",
      "collectIssuesForEnabledAccounts",
      "isRecord",
      "resolveEnabledConfiguredAccountId",
    ]);
    expectSourceMentions("channel-inbound", [
      "buildMentionRegexes",
      "createDirectDmPreCryptoGuardPolicy",
      "createChannelInboundDebouncer",
      "createInboundDebouncer",
      "dispatchInboundDirectDmWithRuntime",
      "formatInboundEnvelope",
      "formatInboundFromLabel",
      "formatLocationText",
      "implicitMentionKindWhen",
      "logInboundDrop",
      "matchesMentionPatterns",
      "matchesMentionWithExplicit",
      "resolveInboundMentionDecision",
      "normalizeMentionText",
      "resolveInboundDebounceMs",
      "resolveEnvelopeFormatOptions",
      "resolveInboundSessionEnvelopeContext",
      "resolveMentionGating",
      "resolveMentionGatingWithBypass",
      "shouldDebounceTextInbound",
      "toLocationContext",
    ]);
    expectSourceContract("reply-runtime", {
      omits: [
        "buildMentionRegexes",
        "formatInboundEnvelope",
        "formatInboundFromLabel",
        "matchesMentionPatterns",
        "matchesMentionWithExplicit",
        "normalizeMentionText",
        "resolveEnvelopeFormatOptions",
        "hasControlCommand",
        "buildCommandTextFromArgs",
        "buildCommandsPaginationKeyboard",
        "buildModelsProviderData",
        "listNativeCommandSpecsForConfig",
        "listSkillCommandsForAgents",
        "normalizeCommandBody",
        "resolveCommandAuthorization",
        "resolveStoredModelOverride",
        "shouldComputeCommandAuthorized",
        "shouldHandleTextCommands",
      ],
    });
    expectSourceMentions("channel-setup", [
      "createOptionalChannelSetupSurface",
      "createTopLevelChannelDmPolicy",
    ]);
    expectSourceContract("channel-actions", {
      mentions: [
        "createUnionActionGate",
        "listTokenSourcedAccounts",
        "resolveReactionMessageId",
        "createMessageToolButtonsSchema",
        "createMessageToolCardSchema",
      ],
    });
    expectSourceMentions("channel-targets", [
      "applyChannelMatchMeta",
      "buildChannelKeyCandidates",
      "buildMessagingTarget",
      "ChannelId",
      "createAllowedChatSenderMatcher",
      "ensureTargetId",
      "normalizeChannelId",
      "parseChatAllowTargetPrefixes",
      "parseMentionPrefixOrAtUserTarget",
      "parseChatTargetPrefixesOrThrow",
      "requireTargetKind",
      "resolveChannelEntryMatchWithFallback",
      "resolveChannelMatchConfig",
      "resolveServicePrefixedAllowTarget",
      "resolveServicePrefixedChatTarget",
      "resolveServicePrefixedOrChatAllowTarget",
      "resolveServicePrefixedTarget",
      "resolveTargetsWithOptionalToken",
    ]);
    expectSourceMentions("channel-config-writes", [
      "authorizeConfigWrite",
      "canBypassConfigWritePolicy",
      "formatConfigWriteDeniedMessage",
      "resolveChannelConfigWrites",
    ]);
    expectSourceMentions("channel-feedback", [
      "createStatusReactionController",
      "logAckFailure",
      "logTypingFailure",
      "removeAckReactionAfterReply",
      "shouldAckReaction",
      "shouldAckReactionForWhatsApp",
      "DEFAULT_EMOJIS",
    ]);
    expectSourceMentions("status-helpers", [
      "appendMatchMetadata",
      "asString",
      "collectIssuesForEnabledAccounts",
      "isRecord",
      "resolveEnabledConfiguredAccountId",
    ]);
    expectSourceMentions("outbound-runtime", [
      "createRuntimeOutboundDelegates",
      "resolveOutboundSendDep",
      "resolveAgentOutboundIdentity",
    ]);
    expectSourceMentions("command-auth", [
      "buildCommandTextFromArgs",
      "buildCommandsMessage",
      "buildCommandsMessagePaginated",
      "buildCommandsPaginationKeyboard",
      "buildHelpMessage",
      "buildModelsProviderData",
      "hasControlCommand",
      "listNativeCommandSpecsForConfig",
      "listSkillCommandsForAgents",
      "normalizeCommandBody",
      "createPreCryptoDirectDmAuthorizer",
      "resolveCommandAuthorization",
      "resolveCommandAuthorizedFromAuthorizers",
      "resolveInboundDirectDmAccessWithRuntime",
      "resolveControlCommandGate",
      "resolveDualTextControlCommandGate",
      "resolveNativeCommandSessionTargets",
      "resolveStoredModelOverride",
      "shouldComputeCommandAuthorized",
      "shouldHandleTextCommands",
    ]);
    expectSourceMentions("command-status", [
      "buildCommandsMessage",
      "buildCommandsMessagePaginated",
      "buildHelpMessage",
    ]);
    expectSourceOmitsImportPattern("command-auth", "../auto-reply/status.js");
    expectSourceOmitsSnippet("command-auth", "../../extensions/");
    expectSourceOmitsSnippet("matrix-runtime-heavy", "../../extensions/");
    expectSourceMentions("channel-send-result", [
      "attachChannelToResult",
      "buildChannelSendResult",
    ]);
    expectSourceMentions("direct-dm", [
      "createDirectDmPreCryptoGuardPolicy",
      "createPreCryptoDirectDmAuthorizer",
      "dispatchInboundDirectDmWithRuntime",
      "resolveInboundDirectDmAccessWithRuntime",
    ]);

    expectSourceMentions("conversation-runtime", [
      "formatThreadBindingDisabledError",
      "resolveThreadBindingFarewellText",
      "resolveThreadBindingConversationIdFromBindingId",
      "resolveThreadBindingEffectiveExpiresAt",
      "resolveThreadBindingIdleTimeoutMs",
      "resolveThreadBindingIdleTimeoutMsForChannel",
      "resolveThreadBindingIntroText",
      "resolveThreadBindingLifecycle",
      "resolveThreadBindingMaxAgeMs",
      "resolveThreadBindingMaxAgeMsForChannel",
      "resolveThreadBindingSpawnPolicy",
      "resolveThreadBindingThreadName",
      "resolveThreadBindingsEnabled",
      "formatThreadBindingDurationLabel",
      "createScopedAccountReplyToModeResolver",
      "createStaticReplyToModeResolver",
      "createTopLevelChannelReplyToModeResolver",
    ]);

    expectSourceMentions("thread-bindings-runtime", [
      "resolveThreadBindingFarewellText",
      "resolveThreadBindingLifecycle",
      "registerSessionBindingAdapter",
      "unregisterSessionBindingAdapter",
      "SessionBindingAdapter",
    ]);
    expectSourceMentions("matrix-runtime-shared", ["formatZonedTimestamp"]);
    expectSourceMentions("ssrf-runtime", [
      "closeDispatcher",
      "createPinnedDispatcher",
      "resolvePinnedHostnameWithPolicy",
      "formatErrorMessage",
      "assertHttpUrlTargetsPrivateNetwork",
      "ssrfPolicyFromDangerouslyAllowPrivateNetwork",
      "ssrfPolicyFromAllowPrivateNetwork",
    ]);

    expectSourceContract("provider-setup", {
      mentions: [
        "applyProviderDefaultModel",
        "discoverOpenAICompatibleLocalModels",
        "discoverOpenAICompatibleSelfHostedProvider",
      ],
      omits: [
        "buildOllamaProvider",
        "configureOllamaNonInteractive",
        "ensureOllamaModelPulled",
        "promptAndConfigureOllama",
        "promptAndConfigureVllm",
        "buildVllmProvider",
        "buildSglangProvider",
        "OLLAMA_DEFAULT_BASE_URL",
        "OLLAMA_DEFAULT_MODEL",
        "VLLM_DEFAULT_BASE_URL",
      ],
    });
    expectSourceOmitsImportPattern("provider-setup", "./vllm.js");
    expectSourceOmitsImportPattern("provider-setup", "./sglang.js");
    expectSourceMentions("provider-auth", [
      "buildOauthProviderAuthResult",
      "generateHexPkceVerifierChallenge",
      "generatePkceVerifierChallenge",
      "toFormUrlEncoded",
    ]);
    expectSourceOmits("core", ["buildOauthProviderAuthResult"]);
    expectSourceContract("provider-model-shared", {
      mentions: ["DEFAULT_CONTEXT_TOKENS", "normalizeModelCompat", "cloneFirstTemplateModel"],
      omits: ["applyOpenAIConfig", "buildKilocodeModelDefinition", "discoverHuggingfaceModels"],
    });
    expectSourceContract("provider-catalog-shared", {
      mentions: ["buildSingleProviderApiKeyCatalog", "buildPairedProviderApiKeyCatalog"],
      omits: ["buildDeepSeekProvider", "buildOpenAICodexProvider", "buildVeniceProvider"],
    });

    expectSourceMentions("setup", [
      "DEFAULT_ACCOUNT_ID",
      "createAllowFromSection",
      "createDelegatedSetupWizardProxy",
      "createTopLevelChannelDmPolicy",
      "mergeAllowFromEntries",
    ]);
    expectSourceMentions("setup-tools", ["formatCliCommand", "detectBinary", "formatDocsLink"]);
    expectSourceMentions("lazy-runtime", ["createLazyRuntimeSurface", "createLazyRuntimeModule"]);
    expectSourceContract("self-hosted-provider-setup", {
      mentions: [
        "applyProviderDefaultModel",
        "discoverOpenAICompatibleLocalModels",
        "discoverOpenAICompatibleSelfHostedProvider",
        "configureOpenAICompatibleSelfHostedProviderNonInteractive",
      ],
      omits: ["buildVllmProvider", "buildSglangProvider"],
    });
    expectSourceOmitsImportPattern("self-hosted-provider-setup", "./vllm.js");
    expectSourceOmitsImportPattern("self-hosted-provider-setup", "./sglang.js");
    expectSourceOmitsSnippet("agent-runtime", "./sglang.js");
    expectSourceOmitsSnippet("agent-runtime", "./vllm.js");
    expectSourceOmitsSnippet("agent-runtime", "../../extensions/");
    expectSourceOmitsSnippet("google-model-id", "./google.js");
    expectSourceOmitsSnippet("google-model-id", "./facade-runtime.js");
    expectSourceOmitsSnippet("google-model-id", "../../extensions/");
    expectSourceOmitsSnippet("xai-model-id", "./xai.js");
    expectSourceOmitsSnippet("xai-model-id", "./facade-runtime.js");
    expectSourceOmitsSnippet("xai-model-id", "../../extensions/");
    expectSourceMentions("sandbox", ["registerSandboxBackend", "runPluginCommandWithTimeout"]);

    expectSourceMentions("secret-input", [
      "buildSecretInputSchema",
      "buildOptionalSecretInputSchema",
      "normalizeSecretInputString",
    ]);
    expectSourceMentions("provider-http", [
      "assertOkOrThrowHttpError",
      "normalizeBaseUrl",
      "postJsonRequest",
      "postTranscriptionRequest",
      "requireTranscriptionText",
    ]);
    expectSourceOmits("speech", [
      "buildElevenLabsSpeechProvider",
      "buildMicrosoftSpeechProvider",
      "buildOpenAISpeechProvider",
      "edgeTTS",
      "elevenLabsTTS",
      "inferEdgeExtension",
      "openaiTTS",
      "OPENAI_TTS_MODELS",
      "OPENAI_TTS_VOICES",
    ]);
    expectSourceOmits("media-understanding", [
      "deepgramMediaUnderstandingProvider",
      "groqMediaUnderstandingProvider",
      "assertOkOrThrowHttpError",
      "postJsonRequest",
      "postTranscriptionRequest",
    ]);
    expectSourceOmits("image-generation", [
      "buildFalImageGenerationProvider",
      "buildGoogleImageGenerationProvider",
      "buildOpenAIImageGenerationProvider",
    ]);
    expectSourceOmits("config-runtime", [
      "hasConfiguredSecretInput",
      "normalizeResolvedSecretInputString",
      "normalizeSecretInputString",
    ]);
    expectSourceMentions("webhook-ingress", [
      "registerPluginHttpRoute",
      "resolveWebhookPath",
      "readRequestBodyWithLimit",
      "readJsonWebhookBodyOrReject",
      "requestBodyErrorToText",
      "withResolvedWebhookRequestPipeline",
    ]);
    expectSourceMentions("testing", ["removeAckReactionAfterReply", "shouldAckReaction"]);
  });

  it("keeps shared plugin-sdk types aligned", () => {
    expectTypeOf<ContractBaseProbeResult>().toMatchTypeOf<BaseProbeResult>();
    expectTypeOf<ContractBaseTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
    expectTypeOf<ContractChannelAgentTool>().toMatchTypeOf<ChannelAgentTool>();
    expectTypeOf<ContractChannelAccountSnapshot>().toMatchTypeOf<ChannelAccountSnapshot>();
    expectTypeOf<ContractChannelGroupContext>().toMatchTypeOf<ChannelGroupContext>();
    expectTypeOf<ContractChannelMessageActionAdapter>().toMatchTypeOf<ChannelMessageActionAdapter>();
    expectTypeOf<ContractChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
    expectTypeOf<ContractChannelMessageActionName>().toMatchTypeOf<ChannelMessageActionName>();
    expectTypeOf<ContractChannelMessageToolDiscovery>().toMatchTypeOf<ChannelMessageToolDiscovery>();
    expectTypeOf<ContractChannelStatusIssue>().toMatchTypeOf<ChannelStatusIssue>();
    expectTypeOf<ContractChannelThreadingContext>().toMatchTypeOf<ChannelThreadingContext>();
    expectTypeOf<ContractChannelThreadingToolContext>().toMatchTypeOf<ChannelThreadingToolContext>();
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<OpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<PluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<SharedOpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<SharedPluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<SharedChannelMessageActionContext>();
  });

  it("keeps runtime entry subpaths importable", async () => {
    const coreSdk = await importResolvedPluginSdkSubpath("openclaw/plugin-sdk/core");
    const channelActionsSdk = await importResolvedPluginSdkSubpath(
      "openclaw/plugin-sdk/channel-actions",
    );
    const globalSingletonSdk = await importResolvedPluginSdkSubpath(
      "openclaw/plugin-sdk/global-singleton",
    );
    const textRuntimeSdk = await importResolvedPluginSdkSubpath("openclaw/plugin-sdk/text-runtime");
    const pluginEntrySdk = await importResolvedPluginSdkSubpath("openclaw/plugin-sdk/plugin-entry");
    const channelLifecycleSdk = await importResolvedPluginSdkSubpath(
      "openclaw/plugin-sdk/channel-lifecycle",
    );
    const channelPairingSdk = await importResolvedPluginSdkSubpath(
      "openclaw/plugin-sdk/channel-pairing",
    );
    const channelReplyPipelineSdk = await importResolvedPluginSdkSubpath(
      "openclaw/plugin-sdk/channel-reply-pipeline",
    );
    const representativeModules = [];
    for (const id of representativeRuntimeSmokeSubpaths) {
      representativeModules.push(await importResolvedPluginSdkSubpath(`openclaw/plugin-sdk/${id}`));
    }

    expect(coreSdk.definePluginEntry).toBe(pluginEntrySdk.definePluginEntry);
    expect(typeof coreSdk.optionalStringEnum).toBe("function");
    expect(typeof channelActionsSdk.optionalStringEnum).toBe("function");
    expect(typeof channelActionsSdk.stringEnum).toBe("function");
    expect(typeof globalSingletonSdk.resolveGlobalMap).toBe("function");
    expect(typeof globalSingletonSdk.resolveGlobalSingleton).toBe("function");
    expect(typeof globalSingletonSdk.createScopedExpiringIdCache).toBe("function");
    expect(typeof textRuntimeSdk.createScopedExpiringIdCache).toBe("function");
    expect(typeof textRuntimeSdk.resolveGlobalMap).toBe("function");
    expect(typeof textRuntimeSdk.resolveGlobalSingleton).toBe("function");
    expectSourceMentions("infra-runtime", ["createRuntimeOutboundDelegates"]);
    expectSourceContains("infra-runtime", "../infra/outbound/send-deps.js");
    expectSourceMentions("error-runtime", ["formatUncaughtError", "isApprovalNotFoundError"]);

    expect(typeof channelLifecycleSdk.createDraftStreamLoop).toBe("function");
    expect(typeof channelLifecycleSdk.createFinalizableDraftLifecycle).toBe("function");
    expect(typeof channelLifecycleSdk.runPassiveAccountLifecycle).toBe("function");
    expect(typeof channelLifecycleSdk.createRunStateMachine).toBe("function");
    expect(typeof channelLifecycleSdk.createArmableStallWatchdog).toBe("function");

    expectSourceMentions("channel-pairing", [
      "createChannelPairingController",
      "createChannelPairingChallengeIssuer",
      "createLoggedPairingApprovalNotifier",
      "createPairingPrefixStripper",
      "readChannelAllowFromStoreSync",
      "createTextPairingAdapter",
    ]);
    expect("createScopedPairingAccess" in channelPairingSdk).toBe(false);

    expectSourceMentions("channel-reply-pipeline", [
      "createChannelReplyPipeline",
      "createTypingCallbacks",
      "createReplyPrefixContext",
      "createReplyPrefixOptions",
    ]);
    expect(typeof channelReplyPipelineSdk.createTypingCallbacks).toBe("function");
    expect(typeof channelReplyPipelineSdk.createReplyPrefixContext).toBe("function");
    expect(typeof channelReplyPipelineSdk.createReplyPrefixOptions).toBe("function");

    expect(pluginSdkSubpaths.length).toBeGreaterThan(representativeRuntimeSmokeSubpaths.length);
    for (const [index, id] of representativeRuntimeSmokeSubpaths.entries()) {
      const mod = representativeModules[index];
      expect(typeof mod).toBe("object");
      expect(mod, `subpath ${id} should resolve`).toBeTruthy();
    }
  });

  it("exports single-provider plugin entry helpers from the dedicated subpath", () => {
    expect(typeof providerEntrySdk.defineSingleProviderPluginEntry).toBe("function");
  });
});
