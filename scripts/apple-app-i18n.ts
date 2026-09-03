import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NATIVE_I18N_LOCALES } from "./native-i18n-locales.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REQUIRED_LOCALES = ["en", ...NATIVE_I18N_LOCALES];
const FORMAT_RE = /%(?:%|(?:\d+\$)?(?:lld|ld|[@a-z]))/giu;
const INFLECTED_COUNT_INTERPOLATION_RE = /\\\([A-Za-z_][A-Za-z0-9_]*\)/gu;
const INFLECTED_COUNT_INTERPOLATION_EXACT_RE = /^\\\([A-Za-z_][A-Za-z0-9_]*\)$/u;
const INFLECTED_COUNT_SEGMENT_RE =
  /\^\[[^\]]*\\\([A-Za-z_][A-Za-z0-9_]*\)[^\]]*\]\(inflect: true\)/gu;
const INFLECTED_COUNT_MARKER = "](inflect: true)";
const IOS_CATALOG_PATH = "apps/ios/Resources/Localizable.xcstrings";
const MACOS_CATALOG_PATH = "apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings";
const MACOS_INFO_PLIST_PATH = "apps/macos/Sources/OpenClaw/Resources/Info.plist";
const NATIVE_SOURCE_PATH = "apps/.i18n/native-source.json";
const NATIVE_TRANSLATIONS_DIR = "apps/.i18n/native";
const SHARED_CHAT_UI_SOURCE_PREFIX = "apps/shared/OpenClawKit/Sources/OpenClawChatUI/";
const SHARED_GATEWAY_DISCOVERY_STATUS_SOURCE =
  "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayDiscoveryStatusText.swift";
const IOS_SOURCE_PREFIXES = [
  "apps/ios/",
  SHARED_CHAT_UI_SOURCE_PREFIX,
  "apps/shared/OpenClawKit/Sources/OpenClawKit/",
] as const;
const IOS_CATALOG_EXCLUSIONS = new Set([
  // Product names and preview-only single-character fixtures are intentionally verbatim.
  "OpenClaw",
  "z",
]);
const MACOS_SOURCE_PREFIXES = [
  "apps/macos/Sources/OpenClaw/",
  SHARED_CHAT_UI_SOURCE_PREFIX,
  SHARED_GATEWAY_DISCOVERY_STATUS_SOURCE,
] as const;
const MACOS_CATALOG_EXCLUSIONS = new Set([
  // Product names are intentionally verbatim.
  "OpenClaw",
]);
const IOS_INFO_PLIST_TARGETS = [
  {
    outputRoot: "apps/ios/Sources",
    sourcePath: "apps/ios/Sources/Info.plist",
  },
  {
    outputRoot: "apps/ios/WatchApp",
    sourcePath: "apps/ios/WatchApp/Info.plist",
  },
  {
    outputRoot: "apps/ios/ShareExtension",
    sourcePath: "apps/ios/ShareExtension/Info.plist",
  },
  {
    outputRoot: "apps/ios/ActivityWidget",
    sourcePath: "apps/ios/ActivityWidget/Info.plist",
  },
] as const;
const INFO_PLIST_LOCALIZABLE_KEYS = new Set(["NSScreenCaptureDescription"]);
const AMBIGUOUS_RUNTIME_INTERPOLATIONS = [
  {
    label: "interpolated localized resource",
    pattern:
      /(?:\bString\s*\(\s*localized:|\bAttributedString\s*\(\s*localized:|\bLocalizedString(?:Key|Resource)\s*\(|(?:\b[A-Za-z_]\w*)?\.localized(?:Format)?\s*\()\s*"((?:\\.|[^"\\])*)"/gu,
    allowsInflection: true,
  },
  {
    label: "interpolated multiline localized resource",
    pattern:
      /\b(?:String\s*\(\s*localized:|AttributedString\s*\(\s*localized:|LocalizedString(?:Key|Resource)\s*\()\s*"""([\s\S]*?)"""/gu,
    allowsInflection: true,
  },
  {
    label: "interpolated SwiftUI text literal",
    pattern:
      /\b(?:Text|Label|Button|TextField|SecureField|Picker|Section|LabeledContent|Toggle|Menu|ShareLink|Link|TextEditor|ProgressView|Gauge|DisclosureGroup|ControlGroup|DatePicker|Stepper)\s*\(\s*"((?:\\.|[^"\\])*)"/gu,
    allowsInflection: false,
  },
  {
    label: "interpolated multiline SwiftUI text literal",
    pattern:
      /\b(?:Text|Label|Button|TextField|SecureField|Picker|Section|LabeledContent|Toggle|Menu|ShareLink|Link|TextEditor|ProgressView|Gauge|DisclosureGroup|ControlGroup|DatePicker|Stepper)\s*\(\s*"""([\s\S]*?)"""/gu,
    allowsInflection: false,
  },
  {
    label: "interpolated multiline SwiftUI modifier literal",
    pattern:
      /\.(?:accessibilityLabel|accessibilityHint|alert|confirmationDialog|help|navigationTitle)\s*\(\s*"""([\s\S]*?)"""/gu,
    allowsInflection: false,
  },
  {
    label: "interpolated SwiftUI modifier literal",
    pattern:
      /\.(?:accessibilityLabel|accessibilityHint|alert|confirmationDialog|help|navigationTitle)\s*\(\s*"((?:\\.|[^"\\])*)"/gu,
    allowsInflection: false,
  },
  {
    label: "interpolated accessibility model literal",
    pattern: /\baccessibilityLabel\s*:\s*"((?:\\.|[^"\\])*)"/gu,
    allowsInflection: false,
  },
] as const;

export function findAmbiguousRuntimeInterpolations(source: string): string[] {
  const violations: string[] = [];
  for (const { label, pattern, allowsInflection } of AMBIGUOUS_RUNTIME_INTERPOLATIONS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const literal = match[1] ?? "";
      if (!literal.includes("\\(") || (allowsInflection && isInflectedCountSource(literal))) {
        continue;
      }
      violations.push(label);
      break;
    }
  }
  return violations;
}
const APPLE_LOCALE_DIRECTORIES: Record<string, string> = {
  "ja-JP": "ja",
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
};
const LOCALIZED_WRAPPER_CONTRACTS: Record<string, readonly string[]> = {
  "apps/macos/Sources/OpenClaw/SettingsComponents.swift": [
    "enum SettingsTextValue: ExpressibleByStringLiteral",
    "case localized(LocalizedStringKey)",
    "case verbatim(String)",
    "static func localized(_ value: String) -> Self",
    "struct SettingsPageHeader: View {\n    let title: SettingsTextValue\n    let subtitle: SettingsTextValue?",
    "struct SettingsCardGroup<Content: View>: View {\n    let title: SettingsTextValue",
    "struct SettingsCardRow<Content: View>: View {\n    let title: SettingsTextValue\n    let subtitle: SettingsTextValue?",
    "struct SettingsCardToggleRow: View {\n    let title: SettingsTextValue\n    let subtitle: SettingsTextValue?",
    "Text(verbatim: value)",
  ],
  "apps/ios/Sources/Design/OpenClawProComponents.swift": [
    "enum OpenClawTextValue: ExpressibleByStringLiteral",
    "struct ProSectionHeader: View {\n    let title: OpenClawTextValue",
    "struct OpenClawNoticeBanner: View {\n    let icon: String\n    let title: OpenClawTextValue\n    let message: OpenClawTextValue",
    "struct OpenClawAdaptiveHeaderRow<Leading: View, Accessory: View>: View {\n    let title: OpenClawTextValue\n    let subtitle: OpenClawTextValue?",
    "struct OpenClawStatusBadge: View {\n    @Environment(\\.colorScheme) private var colorScheme\n    let label: OpenClawTextValue",
    "struct ProMetricTile: View {\n    @Environment(\\.colorScheme) private var colorScheme\n    let title: OpenClawTextValue",
    "struct ProPanelHeader: View {\n    let title: OpenClawTextValue",
    "struct ProStatusRow: View {\n    let icon: String\n    let title: OpenClawTextValue\n    let detail: OpenClawTextValue",
  ],
  "apps/ios/Sources/Design/SettingsProTabSupport.swift": [
    "struct SettingsDetailRow: View {\n    let label: LocalizedStringKey\n    let value: OpenClawTextValue",
    "init(_ label: LocalizedStringKey, value: OpenClawTextValue)",
    "self.value.text",
    "struct SettingsApprovalItem: Identifiable {\n    let id: String\n    let icon: String\n    let title: OpenClawTextValue\n    let detail: OpenClawTextValue\n    let priority: OpenClawTextValue",
    "self.item.title.text",
    "self.item.detail.text",
    "self.item.priority.text",
  ],
  "apps/ios/Sources/Design/SettingsChannelsDestination.swift": [
    "Text(verbatim: self.summaryDetail)",
    "Text(verbatim: self.entry.label)",
    "Text(verbatim: self.entry.detailText)",
    "Text(verbatim: account.displayName)",
    "Text(verbatim: account.detailText)",
  ],
  "apps/ios/Sources/Design/SettingsProTabActions.swift": [
    "func detailStatusCard(\n        icon: String,\n        title: OpenClawTextValue,\n        detail: OpenClawTextValue,\n        value: OpenClawTextValue",
    "func diagnosticCheckRow(\n        icon: String,\n        title: OpenClawTextValue,\n        detail: OpenClawTextValue,\n        value: OpenClawTextValue",
    "pendingApproval.commandPreview.map(OpenClawTextValue.verbatim)",
    'format: String(localized: "Agent: %@")',
  ],
  "apps/ios/Sources/Design/SettingsProTabSections.swift": [
    "func settingsListRow(\n        icon: String,\n        iconColor: Color,\n        title: LocalizedStringKey",
    "func aboutLinkRow(\n        title: LocalizedStringKey",
    "func toggleCard(title: LocalizedStringKey",
    "func gatewaySecureField(\n        _ placeholder: LocalizedStringKey",
    "func settingsToggle(\n        _ title: LocalizedStringKey",
    ".accessibilityLabel(Text(placeholder))",
    ".accessibilityLabel(Text(title))",
  ],
  "apps/ios/Sources/Gateway/GatewayConnectionController+Capabilities.swift": [
    'String(localized: "Secure connection is required for this host.")',
    'String(localized: "Use only on a trusted private network.")',
  ],
  "apps/ios/Sources/Gateway/ExecApprovalPromptDialog.swift": [
    "private struct ExecApprovalPromptMetadataRow: View {\n    let label: LocalizedStringKey",
    'localized: "about ^[\\(minutes) minute](inflect: true)"',
    'localized: "about ^[\\(hours) hour](inflect: true)"',
  ],
  "apps/ios/Sources/Voice/TalkGatewayPermissionState.swift": [
    'String(format: String(localized: "Missing %@"), scope)',
    'String(localized: "Requesting approval")',
  ],
  "apps/ios/Sources/Voice/TalkModeManager.swift": [
    'format: String(localized: "Speech error: %@")',
    'format: String(localized: "Speak failed: %@")',
    'self.setStatus(String(localized: "Listening (PTT)"), phase: .listening)',
  ],
  "apps/ios/Sources/Voice/VoiceWakeManager.swift": [
    'format: String(localized: "Recognizer error: %@")',
    'self.statusText = String(localized: "Triggered")',
  ],
  "apps/ios/Sources/Design/AgentProNodesDestination.swift": [
    "private func nodeDetailRow(\n        _ title: OpenClawTextValue,\n        copyLabel: LocalizedStringKey",
    "private func nodeListCard(title: OpenClawTextValue, values: [String])",
  ],
  "apps/ios/Sources/Design/AgentProDetailComponents.swift": [
    "func agentProDetailMetric(label: OpenClawTextValue, value: String)",
    "label.text",
    "Text(verbatim: value)",
    "func agentProEmptyDetailRow(\n    icon: String,\n    title: OpenClawTextValue,\n    detail: OpenClawTextValue)",
    "title.text",
    "detail.text",
  ],
  "apps/ios/Sources/Design/CommandCenterSupport.swift": [
    "Text(verbatim: self.item.title)",
    "Text(verbatim: self.item.trailing)",
    "Text(verbatim: self.item.detail)",
    "struct CommandEmptyStateRow: View {\n    let icon: String\n    let title: OpenClawTextValue\n    let detail: OpenClawTextValue",
    "private func actionButton(\n        _ title: OpenClawTextValue",
    "self.actionButton(.verbatim(category)",
  ],
  "apps/ios/Sources/Design/IPadSkillWorkshopScreen.swift": [
    'format: String(localized: "No proposals in %@")',
  ],
  "apps/ios/Sources/Design/IPadWorkboardScreen.swift": [
    'format: String(localized: "No cards in %@")',
    'format: String(localized: "Move to %@")',
  ],
  "apps/ios/Sources/Gateway/GatewayQuickSetupSheet.swift": [
    "fullRowToggle(_ title: LocalizedStringKey",
    "private struct GatewayQuickSetupStatusRow: View {\n    let title: LocalizedStringKey\n    let value: String",
    "Text(LocalizedStringKey(availability.actionTitle))",
    "Text(verbatim: self.message)",
  ],
  "apps/ios/Sources/Gateway/GatewayProblemView.swift": [
    "title: .verbatim(self.problem.localizedTitle)",
    "message: .verbatim(self.problem.localizedMessage)",
    "Text(verbatim: primaryActionTitle)",
  ],
  "apps/ios/Sources/Settings/PrivacyAccessSectionView.swift": [
    "detail: LocalizedStringResource",
    "statusLabel: LocalizedStringResource? = nil",
    "actionTitle: LocalizedStringResource?",
  ],
  "apps/ios/Sources/Permissions/DevicePermissionRow.swift": [
    "title: LocalizedStringResource",
    "detail: LocalizedStringResource",
    "statusLabel: LocalizedStringResource?",
    "actionTitle: LocalizedStringResource?",
    "Text(self.title)",
    "Text(actionTitle)",
  ],
  "apps/ios/Sources/LiveActivity/LiveActivityManager.swift": [
    'String(localized: "Connecting...")',
    "status: .disconnected",
  ],
  "apps/ios/WatchApp/Sources/WatchInboxView.swift": [
    "enum WatchTextValue {\n    case localized(LocalizedStringResource)",
    "private struct WatchFaceHeader: View {\n    let section: WatchTextValue\n    let title: WatchTextValue\n    let subtitle: WatchTextValue",
    "private struct WatchHeroCard: View {\n    let label: WatchTextValue\n    let title: WatchTextValue\n    let subtitle: WatchTextValue",
    "private struct WatchStackCard: View {\n    let label: WatchTextValue\n    let title: WatchTextValue\n    let subtitle: WatchTextValue",
    "private struct WatchDecisionButton: View {\n    let title: LocalizedStringKey",
    'format: String(localized: "Expires in %@")',
    'String(localized: "Pending review")',
    'String(localized: "Review command below")',
    "title: .verbatim(record.approval.commandPreview",
  ],
  "apps/ios/WatchApp/Sources/WatchDirectNode.swift": [
    'private(set) var statusText = String(\n        localized: "Use iPhone Settings to enable direct connection.")',
    'format: String(localized: "Direct connection failed: %@")',
  ],
  "apps/ios/WatchApp/Sources/WatchInboxStore.swift": [
    "WatchAppCommandStatus(command: command, code: .sending)",
    "WatchAppCommandStatus(command: command, code: .sent)",
    "WatchAppCommandStatus(command: command, code: .queued)",
  ],
};
const RAW_LOCALIZATION_BYPASSES: Record<string, readonly string[]> = {
  "apps/macos/Sources/OpenClaw/SettingsComponents.swift": [
    "let title: String",
    "let subtitle: String?",
    "Text(self.title)",
    "Text(subtitle)",
  ],
  "apps/ios/Sources/Design/SettingsProTabSections.swift": [
    "func settingsListRow(\n        icon: String,\n        iconColor: Color,\n        title: String",
    "func aboutLinkRow(title: String",
    "func toggleCard(title: String",
    "func gatewayActionButton(\n        title: String",
    "func gatewaySecureField(_ placeholder: String",
    "func settingsToggle(\n        _ title: String",
    ".accessibilityLabel(title)",
  ],
  "apps/ios/Sources/Gateway/GatewayConnectionController+Capabilities.swift": [
    'helperText: "Secure connection is required for this host."',
    'helperText: "Use only on a trusted private network."',
  ],
  "apps/ios/Sources/Gateway/ExecApprovalPromptDialog.swift": [
    "private struct ExecApprovalPromptMetadataRow: View {\n    let label: String",
    'return "under a minute"',
    'return "about 1 minute"',
  ],
  "apps/ios/Sources/Voice/TalkModeManager.swift": [
    'self.statusText = "',
    'streamingOwner.terminalStatus = "',
  ],
  "apps/ios/Sources/Voice/VoiceWakeManager.swift": ['self.statusText = "'],
  "apps/ios/Sources/Design/SettingsProTabSupport.swift": [
    "struct SettingsDetailRow: View {\n    let label: LocalizedStringKey\n    let value: String",
    "init(_ label: LocalizedStringKey, value: String)",
    "Text(self.value)",
    "Text(self.item.title)",
    "Text(self.item.detail)",
    "Text(self.item.priority)",
  ],
  "apps/ios/Sources/Design/SettingsChannelsDestination.swift": [
    "Text(self.summaryDetail)",
    "Text(self.entry.label)",
    "Text(self.entry.detailText)",
    "Text(account.displayName)",
    "Text(account.detailText)",
  ],
  "apps/ios/Sources/Design/AgentProNodesDestination.swift": [
    "private func nodeDetailRow(_ title: String",
    "private func nodeListCard(title: String",
    "private func detailMetric(label: String",
    "private func emptyRow(icon: String, title: String",
  ],
  "apps/ios/Sources/Design/CommandCenterSupport.swift": [
    "Text(self.item.title)",
    "Text(self.item.trailing)",
    "Text(self.item.detail)",
    "struct CommandEmptyStateRow: View {\n    let icon: String\n    let title: String",
    "private func actionButton(\n        _ title: String",
  ],
  "apps/ios/Sources/Design/IPadSkillWorkshopScreen.swift": [
    '"No \\(IPadSkillWorkshopScreen.proposalLaneLabel(self.status).lowercased()) proposals"',
  ],
  "apps/ios/Sources/Design/IPadWorkboardScreen.swift": [
    '"No \\(IPadWorkboardDefaults.label(for: self.status).lowercased()) cards"',
    'Text("Move to \\(IPadWorkboardDefaults.label(for: status))")',
  ],
  "apps/ios/Sources/Design/SettingsProTabActions.swift": [
    "func detailStatusCard(\n        icon: String,\n        title: String",
    "func diagnosticCheckRow(\n        icon: String,\n        title: String",
  ],
  "apps/ios/WatchApp/Sources/WatchInboxView.swift": [
    'parts.append("Expires in \\(expiresText)")',
    'return "Expires in <1m"',
    'return "Expires in \\(deltaSeconds / 60)m"',
    'return "Pending review"',
    'return "Review command below"',
    'return "Stop speaking"',
    'return "Cancel voice turn"',
    'return "Start voice turn"',
  ],
  "apps/ios/WatchApp/Sources/WatchDirectNode.swift": [
    'private(set) var statusText = "',
    'self.statusText = "',
  ],
  "apps/ios/WatchApp/Sources/WatchInboxStore.swift": [
    'self.appSnapshotStatusText = "',
    'self.appCommandStatusText = "',
    'self.execApprovals[index].statusText = "',
    'self.replyStatusText = "',
  ],
};

type StringUnit = {
  state?: string;
  value?: string;
};

type CatalogLocalization = Record<string, unknown> & {
  stringUnit?: StringUnit;
};

type CatalogEntry = Record<string, unknown> & {
  localizations?: Record<string, CatalogLocalization>;
};

type Catalog = {
  sourceLanguage?: string;
  strings?: Record<string, CatalogEntry>;
  version?: string;
};

type NativeSourceEntry = {
  id: string;
  source: string;
  sites: Array<{ kind: string; path: string }>;
  surface: string;
};

type NativeSourceArtifact = {
  entries: NativeSourceEntry[];
  version: number;
};

type NativeTranslationArtifact = {
  locale: string;
  translations: Record<string, string>;
  version: number;
};

export type AppleTranslationContradiction = {
  locale: string;
  source: string;
  translations: string[];
};

export type AppleCatalogBuild = {
  catalog: Catalog;
  contradictions: AppleTranslationContradiction[];
};

function formatTokens(value: string): string[] {
  return [...value.matchAll(FORMAT_RE)].map((match) => match[0]).toSorted();
}

function stringsLiteral(value: string): string {
  return JSON.stringify(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function serializeAppleCatalog(catalog: Catalog): string {
  const topLevelEntries = Object.entries(catalog);
  const lines = ["{"];

  for (const [topLevelIndex, [key, value]] of topLevelEntries.entries()) {
    const comma = topLevelIndex === topLevelEntries.length - 1 ? "" : ",";
    if (key !== "strings" || !value || typeof value !== "object" || Array.isArray(value)) {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
      continue;
    }

    const entries = Object.entries(value);
    lines.push(`  ${JSON.stringify(key)}: {`);
    for (const [entryIndex, [entryKey, entry]] of entries.entries()) {
      const entryComma = entryIndex === entries.length - 1 ? "" : ",";
      lines.push(`    ${JSON.stringify(entryKey)}: ${JSON.stringify(entry)}${entryComma}`);
    }
    lines.push(`  }${comma}`);
  }

  lines.push("}", "");
  return lines.join("\n");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parseInfoPlistStrings(source: string): Array<{ key: string; source: string }> {
  return [...source.matchAll(/<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/gu)]
    .map((match) => ({
      key: decodeXml(match[1] ?? ""),
      source: decodeXml(match[2] ?? ""),
    }))
    .filter(
      (entry) =>
        entry.key.endsWith("UsageDescription") || INFO_PLIST_LOCALIZABLE_KEYS.has(entry.key),
    );
}

type InfoPlistTranslation = {
  source?: string;
  value: string;
};

function parseStringsFile(source: string): Map<string, InfoPlistTranslation> {
  const values = new Map<string, InfoPlistTranslation>();
  for (const match of source.matchAll(
    /(?:^\/\* OpenClaw source: ("(?:\\.|[^"\\])*") \*\/\n)?^\s*("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*");/gmu,
  )) {
    values.set(JSON.parse(match[2] ?? '""') as string, {
      source: match[1] ? (JSON.parse(match[1]) as string) : undefined,
      value: JSON.parse(match[3] ?? '""') as string,
    });
  }
  return values;
}

export function selectInfoPlistTranslation(
  source: string,
  candidates: readonly string[],
  existing?: InfoPlistTranslation,
): string {
  const translatedCandidates = candidates.filter(
    (candidate) => candidate.trim() && candidate.trim() !== source.trim(),
  );
  if (translatedCandidates.length > 0) {
    return chooseTranslation(source, translatedCandidates);
  }
  return existing?.source === source && existing.value.trim() ? existing.value : source;
}

export function infoPlistTranslationCandidates(
  artifact: NativeTranslationArtifact | undefined,
  sourceId: string,
  _source: string,
): string[] {
  const translated = artifact?.translations[sourceId];
  return typeof translated === "string" ? [translated] : [];
}

function infoPlistSourceIds(nativeSource: NativeSourceArtifact): Map<string, string> {
  return new Map(
    nativeSource.entries.flatMap((entry) =>
      entry.sites
        .filter((site) => site.kind === "plist-string")
        .map((site) => [[site.path, entry.source].join("\u0000"), entry.id] as const),
    ),
  );
}

function renderInfoPlistStrings(
  sourcePath: string,
  sourceEntries: ReadonlyArray<{ key: string; source: string }>,
  sourceIds: ReadonlyMap<string, string>,
  artifact: NativeTranslationArtifact | undefined,
  existing: ReadonlyMap<string, InfoPlistTranslation> = new Map(),
): string {
  const lines = sourceEntries.map(({ key, source }) => {
    const sourceId = sourceIds.get([sourcePath, source].join("\u0000"));
    if (!sourceId) {
      throw new Error(`missing native InfoPlist source id for ${sourcePath}:${key}`);
    }
    const candidates = infoPlistTranslationCandidates(artifact, sourceId, source);
    const value = selectInfoPlistTranslation(source, candidates, existing.get(key));
    return [
      `/* OpenClaw source: ${stringsLiteral(source)} */`,
      `${stringsLiteral(key)} = ${stringsLiteral(value)};`,
    ].join("\n");
  });
  return `${lines.join("\n")}\n`;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isAppleCatalogKind(kind: string): boolean {
  return kind === "conditional-branch" || kind.startsWith("ui-");
}

function isAppleCatalogEntry(
  entry: NativeSourceEntry,
  sourcePrefixes: readonly string[],
  exclusions: ReadonlySet<string>,
): boolean {
  return (
    entry.surface === "apple" &&
    entry.sites.some(
      (site) =>
        sourcePrefixes.some((prefix) => site.path.startsWith(prefix)) &&
        isAppleCatalogKind(site.kind),
    ) &&
    (!entry.source.includes("\\(") || isInflectedCountSource(entry.source)) &&
    !exclusions.has(entry.source)
  );
}

function isInflectedCountSource(value: string): boolean {
  if (!value.includes(INFLECTED_COUNT_MARKER)) {
    return false;
  }
  const interpolations = value.match(/\\\([^)]*\)/gu) ?? [];
  const segments = [...value.matchAll(INFLECTED_COUNT_SEGMENT_RE)];
  return (
    segments.length > 0 &&
    interpolations.length === segments.length &&
    interpolations.every((interpolation) =>
      INFLECTED_COUNT_INTERPOLATION_EXACT_RE.test(interpolation),
    ) &&
    segments.every(
      ([segment]) => (segment.match(INFLECTED_COUNT_INTERPOLATION_RE) ?? []).length === 1,
    )
  );
}

function appleCatalogValue(value: string): string {
  if (!isInflectedCountSource(value)) {
    return value;
  }
  return value.replace(INFLECTED_COUNT_SEGMENT_RE, (segment) =>
    segment.replace(INFLECTED_COUNT_INTERPOLATION_RE, "%lld"),
  );
}

function chooseTranslation(source: string, translations: readonly string[]): string {
  // Apple catalogs key by source, so duplicate native contexts must converge.
  // Preserve shipped values first; otherwise choose deterministically and report every conflict.
  const counts = new Map<string, number>();
  for (const translation of translations) {
    counts.set(translation, (counts.get(translation) ?? 0) + 1);
  }
  return (
    [...counts].toSorted(([leftValue, leftCount], [rightValue, rightCount]) => {
      const sourcePenalty = Number(leftValue === source) - Number(rightValue === source);
      return sourcePenalty || rightCount - leftCount || compareCodeUnits(leftValue, rightValue);
    })[0]?.[0] ?? source
  );
}

function buildAppleCatalog(
  existingCatalog: Catalog,
  nativeSource: NativeSourceArtifact,
  translations: readonly NativeTranslationArtifact[],
  includesEntry: (entry: NativeSourceEntry) => boolean,
): AppleCatalogBuild {
  const catalogEntries = nativeSource.entries
    .filter(includesEntry)
    .map((entry) => [entry, appleCatalogValue(entry.source)] as const);
  const sources = [...new Set(catalogEntries.map(([, source]) => source))].toSorted(
    compareCodeUnits,
  );
  const catalogIds = new Set(catalogEntries.map(([entry]) => entry.id));
  const existingStrings = existingCatalog.strings ?? {};
  const nativeEntryById = new Map(nativeSource.entries.map((entry) => [entry.id, entry]));
  const translationsByLocale = new Map(
    translations.map((artifact) => {
      const bySource = new Map<string, string[]>();
      for (const [id, translated] of Object.entries(artifact.translations)) {
        const entry = nativeEntryById.get(id);
        if (!entry || !catalogIds.has(id)) {
          continue;
        }
        const source = appleCatalogValue(entry.source);
        const values = bySource.get(source) ?? [];
        values.push(appleCatalogValue(translated));
        bySource.set(source, values);
      }
      return [artifact.locale, bySource] as const;
    }),
  );
  const contradictions: AppleTranslationContradiction[] = [];
  const strings: Record<string, CatalogEntry> = {};

  for (const source of sources) {
    const existing = existingStrings[source];
    const localizations: NonNullable<CatalogEntry["localizations"]> = {};
    for (const locale of REQUIRED_LOCALES) {
      const candidates = translationsByLocale.get(locale)?.get(source) ?? [];
      const distinct = [...new Set(candidates)].toSorted(compareCodeUnits);
      if (distinct.length > 1) {
        contradictions.push({ locale, source, translations: distinct });
      }
      const existingUnit = existing?.localizations?.[locale]?.stringUnit;
      if (existingUnit?.value && existingUnit.state === "translated") {
        localizations[locale] = { stringUnit: { ...existingUnit } };
        continue;
      }
      if (locale === "en") {
        localizations.en = {
          stringUnit: {
            state: "translated",
            value: source,
          },
        };
        continue;
      }
      const value = chooseTranslation(source, candidates);
      localizations[locale] = {
        stringUnit: {
          state: value === source ? "new" : "translated",
          value,
        },
      };
    }
    strings[source] = { localizations };
  }

  return {
    catalog: {
      sourceLanguage: "en",
      strings,
      version: "1.0",
    },
    contradictions: contradictions.toSorted(
      (left, right) =>
        compareCodeUnits(left.source, right.source) || compareCodeUnits(left.locale, right.locale),
    ),
  };
}

export function buildIosCatalog(
  existingCatalog: Catalog,
  nativeSource: NativeSourceArtifact,
  translations: readonly NativeTranslationArtifact[],
): AppleCatalogBuild {
  return buildAppleCatalog(existingCatalog, nativeSource, translations, (entry) =>
    isAppleCatalogEntry(entry, IOS_SOURCE_PREFIXES, IOS_CATALOG_EXCLUSIONS),
  );
}

export function buildMacosCatalog(
  existingCatalog: Catalog,
  nativeSource: NativeSourceArtifact,
  translations: readonly NativeTranslationArtifact[],
): AppleCatalogBuild {
  return buildAppleCatalog(existingCatalog, nativeSource, translations, (entry) =>
    isAppleCatalogEntry(entry, MACOS_SOURCE_PREFIXES, MACOS_CATALOG_EXCLUSIONS),
  );
}

async function listSwiftFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (
        entry.isDirectory() &&
        /^(?:\.build|build|DerivedData|Previews?|Tests?|UITests?)$/u.test(entry.name)
      ) {
        return [];
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listSwiftFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".swift") ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

async function validateRuntimeInterpolationPaths(): Promise<void> {
  const roots = [...new Set([...IOS_SOURCE_PREFIXES, ...MACOS_SOURCE_PREFIXES])];
  const files = new Set(
    (
      await Promise.all(
        roots.map((prefix) => {
          const sourcePath = path.join(ROOT, prefix);
          return prefix.endsWith(".swift")
            ? Promise.resolve([sourcePath])
            : listSwiftFiles(sourcePath);
        }),
      )
    ).flat(),
  );
  const violations: string[] = [];
  for (const file of [...files].toSorted()) {
    const source = await readFile(file, "utf8");
    for (const label of findAmbiguousRuntimeInterpolations(source)) {
      violations.push(`${path.relative(ROOT, file)}: ${label}`);
    }
  }
  if (violations.length) {
    throw new Error(
      `Apple i18n runtime interpolation bypasses generated catalog coverage:\n${violations.join("\n")}`,
    );
  }
}

async function readNativeTranslations(): Promise<NativeTranslationArtifact[]> {
  const expectedFiles = NATIVE_I18N_LOCALES.map((locale) => `${locale}.json`).toSorted();
  const actualFiles = (
    await readdir(path.join(ROOT, NATIVE_TRANSLATIONS_DIR), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .toSorted();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Apple/native locale parity drift: expected ${JSON.stringify(expectedFiles)}, got ${JSON.stringify(actualFiles)}`,
    );
  }
  return Promise.all(
    NATIVE_I18N_LOCALES.map(async (locale) => {
      const artifact = JSON.parse(
        await readFile(path.join(ROOT, NATIVE_TRANSLATIONS_DIR, `${locale}.json`), "utf8"),
      ) as NativeTranslationArtifact;
      if (artifact.locale !== locale) {
        throw new Error(
          `native Apple translation artifact ${locale} declares locale ${artifact.locale}`,
        );
      }
      return artifact;
    }),
  );
}

async function readIosCatalogBuild(): Promise<AppleCatalogBuild> {
  const existingCatalog = JSON.parse(
    await readFile(path.join(ROOT, IOS_CATALOG_PATH), "utf8"),
  ) as Catalog;
  const nativeSource = JSON.parse(
    await readFile(path.join(ROOT, NATIVE_SOURCE_PATH), "utf8"),
  ) as NativeSourceArtifact;
  const translations = await readNativeTranslations();
  return buildIosCatalog(existingCatalog, nativeSource, translations);
}

async function readMacosCatalogBuild(): Promise<AppleCatalogBuild> {
  const existingCatalog = JSON.parse(
    await readFile(path.join(ROOT, MACOS_CATALOG_PATH), "utf8"),
  ) as Catalog;
  const nativeSource = JSON.parse(
    await readFile(path.join(ROOT, NATIVE_SOURCE_PATH), "utf8"),
  ) as NativeSourceArtifact;
  const translations = await readNativeTranslations();
  return buildMacosCatalog(existingCatalog, nativeSource, translations);
}

function validateCatalog(pathName: string, catalog: Catalog): number {
  if (catalog.sourceLanguage !== "en" || catalog.version !== "1.0" || !catalog.strings) {
    throw new Error(`invalid Apple string catalog: ${pathName}`);
  }
  let checked = 0;
  for (const [key, entry] of Object.entries(catalog.strings)) {
    const sourceTokens = formatTokens(key);
    for (const locale of REQUIRED_LOCALES) {
      const unit = entry.localizations?.[locale]?.stringUnit;
      const value = unit?.value?.trim();
      if (!value || (locale === "en" && unit?.state !== "translated")) {
        throw new Error(
          `Apple catalog ${pathName} is missing ${locale} for ${JSON.stringify(key)}`,
        );
      }
      if (locale !== "en" && unit?.state !== "translated" && unit?.state !== "new") {
        throw new Error(
          `Apple catalog ${pathName} has untranslated ${locale} copy for ${JSON.stringify(key)}`,
        );
      }
      if (formatTokens(value).join("\u0000") !== sourceTokens.join("\u0000")) {
        throw new Error(
          `Apple catalog ${pathName} has placeholder drift in ${locale} for ${JSON.stringify(key)}`,
        );
      }
    }
    checked += 1;
  }
  return checked;
}

async function syncIosInfoPlist(write: boolean): Promise<number> {
  const translations = await readNativeTranslations();
  const nativeSource = JSON.parse(
    await readFile(path.join(ROOT, NATIVE_SOURCE_PATH), "utf8"),
  ) as NativeSourceArtifact;
  const sourceIds = infoPlistSourceIds(nativeSource);
  let checked = 0;
  for (const target of IOS_INFO_PLIST_TARGETS) {
    const sourceEntries = parseInfoPlistStrings(
      await readFile(path.join(ROOT, target.sourcePath), "utf8"),
    );
    for (const locale of NATIVE_I18N_LOCALES) {
      const localeDir = APPLE_LOCALE_DIRECTORIES[locale] ?? locale;
      const outputPath = path.join(
        ROOT,
        target.outputRoot,
        `${localeDir}.lproj`,
        "InfoPlist.strings",
      );
      const existingSource = await readOptionalFile(outputPath);
      const existing = parseStringsFile(existingSource ?? "");
      const artifact = translations.find((candidate) => candidate.locale === locale);
      const expected = renderInfoPlistStrings(
        target.sourcePath,
        sourceEntries,
        sourceIds,
        artifact,
        existing,
      );
      if (existingSource !== expected) {
        if (!write) {
          throw new Error(
            `Apple InfoPlist localization ${path.relative(ROOT, outputPath)} is stale; run apple-app-i18n.ts sync-ios --write`,
          );
        }
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, expected, "utf8");
      }
      checked += 1;
    }
  }
  return checked;
}

export async function syncIosCatalog(write: boolean): Promise<AppleCatalogBuild> {
  const build = await readIosCatalogBuild();
  const catalogPath = path.join(ROOT, IOS_CATALOG_PATH);
  const expected = serializeAppleCatalog(build.catalog);
  const actual = await readFile(catalogPath, "utf8");
  if (actual !== expected) {
    if (!write) {
      throw new Error(
        `Apple catalog ${IOS_CATALOG_PATH} is stale; run apple-app-i18n.ts sync-ios --write`,
      );
    }
    await writeFile(catalogPath, expected, "utf8");
  }
  return build;
}

export async function syncMacosCatalog(write: boolean): Promise<AppleCatalogBuild> {
  const build = await readMacosCatalogBuild();
  const catalogPath = path.join(ROOT, MACOS_CATALOG_PATH);
  const expected = serializeAppleCatalog(build.catalog);
  const actual = await readFile(catalogPath, "utf8");
  if (actual !== expected) {
    if (!write) {
      assertMacosCatalogCurrent(actual, build);
      return build;
    }
    await writeFile(catalogPath, expected, "utf8");
  }
  return build;
}

export function assertMacosCatalogCurrent(actual: string, build: AppleCatalogBuild): void {
  if (actual !== serializeAppleCatalog(build.catalog)) {
    throw new Error(
      `Apple catalog ${MACOS_CATALOG_PATH} is stale; run native-app-i18n.ts sync --write`,
    );
  }
}

/**
 * Regenerates every Apple derived artifact (app catalogs and InfoPlist strings).
 * Shared by this CLI and native-app-i18n's sync so the inventory can never be
 * rewritten without its derived catalogs.
 */
export async function syncAppleAppI18n(): Promise<{
  build: AppleCatalogBuild;
  infoPlistFiles: number;
  macosBuild: AppleCatalogBuild;
}> {
  const [build, macosBuild] = await Promise.all([syncIosCatalog(true), syncMacosCatalog(true)]);
  const infoPlistFiles = await syncIosInfoPlist(true);
  return { build, infoPlistFiles, macosBuild };
}

export async function verifyAppleAppI18n() {
  await validateRuntimeInterpolationPaths();
  for (const [sourcePath, contracts] of Object.entries(LOCALIZED_WRAPPER_CONTRACTS)) {
    const source = await readFile(path.join(ROOT, sourcePath), "utf8");
    const missing = contracts.filter((contract) => !source.includes(contract));
    if (missing.length) {
      throw new Error(
        `Apple i18n wrapper ${sourcePath} bypasses localized string lookup: ${missing.join(", ")}`,
      );
    }
  }
  for (const [sourcePath, bypasses] of Object.entries(RAW_LOCALIZATION_BYPASSES)) {
    const source = await readFile(path.join(ROOT, sourcePath), "utf8");
    const present = bypasses.filter((bypass) => source.includes(bypass));
    if (present.length) {
      throw new Error(
        `Apple i18n runtime path ${sourcePath} contains raw app-owned strings: ${present.join(", ")}`,
      );
    }
  }

  const macosBuild = await readMacosCatalogBuild();
  const macosKeys = validateCatalog(MACOS_CATALOG_PATH, macosBuild.catalog);

  process.stdout.write(`apple-app-i18n: sourceMacosKeys=${macosKeys}\n`);
}

export async function checkAppleAppI18n() {
  await verifyAppleAppI18n();
  const [iosBuild, macosBuild] = await Promise.all([
    syncIosCatalog(false),
    syncMacosCatalog(false),
  ]);
  const iosKeys = validateCatalog(IOS_CATALOG_PATH, iosBuild.catalog);
  const macosKeys = validateCatalog(MACOS_CATALOG_PATH, macosBuild.catalog);
  const infoPlistFiles = await syncIosInfoPlist(false);

  process.stdout.write(
    [
      `apple-app-i18n: iosKeys=${iosKeys}`,
      `macosKeys=${macosKeys}`,
      `infoPlistFiles=${infoPlistFiles}`,
      `translationContradictions=${iosBuild.contradictions.length}`,
      `macosTranslationContradictions=${macosBuild.contradictions.length}`,
      `locales=${NATIVE_I18N_LOCALES.join(",")}`,
      "\n",
    ].join(" "),
  );
}

export async function compileMacosLocalizations(outputDir: string) {
  // Source PRs intentionally leave generated Apple catalogs for the serialized
  // post-merge refresh. Package from the derived catalog so source changes
  // cannot ship stale localization coverage before that refresh lands.
  await verifyAppleAppI18n();
  const catalog = (await readMacosCatalogBuild()).catalog;
  if (!catalog.strings) {
    throw new Error(`invalid Apple string catalog: ${MACOS_CATALOG_PATH}`);
  }
  const [nativeSource, translations, infoPlistSource] = await Promise.all([
    readFile(path.join(ROOT, NATIVE_SOURCE_PATH), "utf8").then(
      (source) => JSON.parse(source) as NativeSourceArtifact,
    ),
    readNativeTranslations(),
    readFile(path.join(ROOT, MACOS_INFO_PLIST_PATH), "utf8"),
  ]);
  const sourceIds = infoPlistSourceIds(nativeSource);
  const infoPlistEntries = parseInfoPlistStrings(infoPlistSource);

  for (const locale of REQUIRED_LOCALES) {
    const localeDir = APPLE_LOCALE_DIRECTORIES[locale] ?? locale;
    const lprojDir = path.join(outputDir, `${localeDir}.lproj`);
    const lines = Object.entries(catalog.strings)
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => {
        const value = entry.localizations?.[locale]?.stringUnit?.value;
        if (!value) {
          throw new Error(
            `Apple catalog ${MACOS_CATALOG_PATH} is missing ${locale} for ${JSON.stringify(key)}`,
          );
        }
        return `${stringsLiteral(key)} = ${stringsLiteral(value)};`;
      });
    await mkdir(lprojDir, { recursive: true });
    await writeFile(path.join(lprojDir, "Localizable.strings"), `${lines.join("\n")}\n`, "utf8");
    if (locale !== "en") {
      const artifact = translations.find((candidate) => candidate.locale === locale);
      const infoPlistStrings = renderInfoPlistStrings(
        MACOS_INFO_PLIST_PATH,
        infoPlistEntries,
        sourceIds,
        artifact,
      );
      await writeFile(path.join(lprojDir, "InfoPlist.strings"), infoPlistStrings, "utf8");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, flag, value] = process.argv.slice(2);
  if (command === "check") {
    await checkAppleAppI18n();
  } else if (command === "sync-ios" && flag === "--write") {
    const { build, infoPlistFiles, macosBuild } = await syncAppleAppI18n();
    process.stdout.write(
      `apple-app-i18n: synced Apple catalogs and ${infoPlistFiles} InfoPlist files; contradictions=${build.contradictions.length + macosBuild.contradictions.length}\n`,
    );
  } else if (command === "compile-macos" && flag === "--output" && value) {
    await compileMacosLocalizations(path.resolve(value));
  } else {
    throw new Error(
      "usage: node --import tsx scripts/apple-app-i18n.ts check|sync-ios --write|compile-macos --output <dir>",
    );
  }
}
