import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NATIVE_I18N_LOCALES } from "./native-app-i18n.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REQUIRED_LOCALES = ["en", ...NATIVE_I18N_LOCALES];
const FORMAT_RE = /%(?:\d+\$)?[@a-z]/giu;
const APPLE_LOCALE_DIRECTORIES: Record<string, string> = {
  "ja-JP": "ja",
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
};
const LOCALIZED_WRAPPER_CONTRACTS: Record<string, string[]> = {
  "apps/ios/Sources/Gateway/GatewayQuickSetupSheet.swift": [
    "fullRowToggle(_ title: LocalizedStringKey",
  ],
  "apps/ios/WatchApp/Sources/WatchInboxView.swift": [
    "private struct WatchPrimaryLabel: View {\n    let title: LocalizedStringKey",
    "private struct WatchSecondaryLabel: View {\n    let title: LocalizedStringKey",
    "private struct WatchSecondaryButton: View {\n    let title: LocalizedStringKey",
    "private struct WatchDecisionButton: View {\n    let title: LocalizedStringKey",
  ],
};

type AppleCatalogSpec = {
  path: string;
  coverage: Record<string, readonly string[]>;
};

const CATALOGS: readonly AppleCatalogSpec[] = [
  {
    path: "apps/ios/Resources/Localizable.xcstrings",
    coverage: {
      "apps/ios/ShareExtension/ShareComposeView.swift": [
        "Add a message, then tap Send.",
        "Cancel",
        "Preparing share…",
        "Send to OpenClaw",
        "Sending to OpenClaw gateway…",
        "Sent to OpenClaw.",
      ],
      "apps/ios/ShareExtension/ShareViewController.swift": [
        "Invalid saved gateway URL.",
        "Message is empty.",
        "OpenClaw is not connected to a gateway yet.",
        "Send failed: %@",
        "The shared image could not be prepared.",
      ],
      "apps/ios/Sources/Design/SettingsChannelsDestination.swift": ["Logout"],
      "apps/ios/Sources/Design/ChatProTab.swift": [
        "Check OpenClaw status",
        "Help me start a realtime voice session from this phone.",
        "Help me start voice chat",
        "Show me which phone controls and device capabilities are available right now.",
        "Summarize the current OpenClaw status and tell me what needs attention.",
        "What can I control here?",
        "What would you like to work on?",
      ],
      "apps/ios/Sources/Gateway/GatewayProblemView.swift": ["Done"],
      "apps/ios/Sources/Gateway/GatewayQuickSetupSheet.swift": [
        "Close",
        "Connect",
        "Connect a nearby Gateway",
        "Connecting…",
        "Don't show this again",
        "Looking for a Gateway",
        "Not now",
        "Quick Setup",
      ],
      "apps/ios/Sources/Gateway/GatewayTrustPromptAlert.swift": [
        "Cancel",
        "First-time TLS connection.\n\nVerify this SHA-256 fingerprint out-of-band before trusting:\n%@",
        "Trust and connect",
        "Trust this gateway?",
      ],
      "apps/ios/Sources/Onboarding/OnboardingWizardSteps.swift": ["Go to Chat"],
      "apps/ios/Sources/RootTabs.swift": ["Agent", "Chat", "Control", "Settings", "Talk"],
      "apps/ios/WatchApp/Sources/WatchInboxView.swift": [
        "Approve",
        "Chat",
        "Continue on iPhone",
        "Deny",
        "Message OpenClaw",
        "No chat synced",
        "Open all approvals",
        "Refresh",
        "Review again",
        "Talk to Claw",
        "Tap the message pill below to start from your watch.",
        "You",
      ],
      "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatMessageViews.swift": ["Writing"],
    },
  },
  {
    path: "apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings",
    coverage: {
      "apps/macos/Sources/OpenClaw/ChannelsSettings+ChannelSections.swift": [
        "Logout",
        "Refresh",
        "Save",
      ],
      "apps/macos/Sources/OpenClaw/CronSettings+Rows.swift": ["Run now"],
    },
  },
];

type Catalog = {
  sourceLanguage?: string;
  strings?: Record<
    string,
    {
      localizations?: Record<string, { stringUnit?: { state?: string; value?: string } }>;
    }
  >;
};

function formatTokens(value: string): string[] {
  return [...value.matchAll(FORMAT_RE)].map((match) => match[0]).toSorted();
}

function stringsLiteral(value: string): string {
  return JSON.stringify(value);
}

export async function checkAppleAppI18n() {
  let checked = 0;
  for (const [sourcePath, contracts] of Object.entries(LOCALIZED_WRAPPER_CONTRACTS)) {
    const source = await readFile(path.join(ROOT, sourcePath), "utf8");
    const missing = contracts.filter((contract) => !source.includes(contract));
    if (missing.length) {
      throw new Error(
        `Apple i18n wrapper ${sourcePath} bypasses localized string lookup: ${missing.join(", ")}`,
      );
    }
  }
  for (const spec of CATALOGS) {
    const catalogPath = path.join(ROOT, spec.path);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
    if (catalog.sourceLanguage !== "en" || !catalog.strings) {
      throw new Error(`invalid Apple string catalog: ${spec.path}`);
    }

    const expectedKeys = new Set(Object.values(spec.coverage).flat());
    const actualKeys = new Set(Object.keys(catalog.strings));
    const missingKeys = [...expectedKeys].filter((key) => !actualKeys.has(key));
    const extraKeys = [...actualKeys].filter((key) => !expectedKeys.has(key));
    if (missingKeys.length || extraKeys.length) {
      throw new Error(
        [
          `Apple catalog ${spec.path} does not match its phased source coverage.`,
          `missing=${missingKeys.join(",") || "none"}`,
          `extra=${extraKeys.join(",") || "none"}`,
        ].join("\n"),
      );
    }

    for (const [sourcePath, keys] of Object.entries(spec.coverage)) {
      const source = await readFile(path.join(ROOT, sourcePath), "utf8");
      const absent = keys.filter((key) => {
        const escapedKey = JSON.stringify(key).slice(1, -1);
        return !source.includes(key) && !source.includes(escapedKey);
      });
      if (absent.length) {
        throw new Error(
          `Apple i18n coverage ${sourcePath} no longer contains: ${absent.join(", ")}`,
        );
      }
    }

    for (const [key, entry] of Object.entries(catalog.strings)) {
      const sourceTokens = formatTokens(key);
      for (const locale of REQUIRED_LOCALES) {
        const unit = entry.localizations?.[locale]?.stringUnit;
        const value = unit?.value?.trim();
        if (!value || (locale === "en" && unit?.state !== "translated")) {
          throw new Error(
            `Apple catalog ${spec.path} is missing ${locale} for ${JSON.stringify(key)}`,
          );
        }
        if (formatTokens(value).join("\u0000") !== sourceTokens.join("\u0000")) {
          throw new Error(
            `Apple catalog ${spec.path} has placeholder drift in ${locale} for ${JSON.stringify(key)}`,
          );
        }
      }
      checked += 1;
    }
  }
  process.stdout.write(
    `apple-app-i18n: catalogs=${CATALOGS.length} keys=${checked} locales=${NATIVE_I18N_LOCALES.join(",")}\n`,
  );
}

export async function compileMacosLocalizations(outputDir: string) {
  await checkAppleAppI18n();
  const spec = CATALOGS[1];
  const catalog = JSON.parse(await readFile(path.join(ROOT, spec.path), "utf8")) as Catalog;
  if (!catalog.strings) {
    throw new Error(`invalid Apple string catalog: ${spec.path}`);
  }

  for (const locale of REQUIRED_LOCALES) {
    const localeDir = APPLE_LOCALE_DIRECTORIES[locale] ?? locale;
    const lprojDir = path.join(outputDir, `${localeDir}.lproj`);
    const lines = Object.entries(catalog.strings)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        const value = entry.localizations?.[locale]?.stringUnit?.value;
        if (!value) {
          throw new Error(
            `Apple catalog ${spec.path} is missing ${locale} for ${JSON.stringify(key)}`,
          );
        }
        return `${stringsLiteral(key)} = ${stringsLiteral(value)};`;
      });
    await mkdir(lprojDir, { recursive: true });
    await writeFile(path.join(lprojDir, "Localizable.strings"), `${lines.join("\n")}\n`, "utf8");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, flag, value] = process.argv.slice(2);
  if (command === "check") {
    await checkAppleAppI18n();
  } else if (command === "compile-macos" && flag === "--output" && value) {
    await compileMacosLocalizations(path.resolve(value));
  } else {
    throw new Error(
      "usage: node --import tsx scripts/apple-app-i18n.ts check|compile-macos --output <dir>",
    );
  }
}
