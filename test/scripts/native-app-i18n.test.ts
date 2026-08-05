import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { ControlUiSharedCatalog } from "../../scripts/lib/control-ui-i18n-shared-catalog.ts";
import {
  assignNativeI18nIds,
  collectNativeI18nEntries,
  extractNativeI18nCandidates,
  isConditionalBranchIdentifier,
  NATIVE_I18N_LOCALES,
  parseNativeI18nCommand,
  syncNativeLocale,
  type NativeI18nEntry,
  validateNativeLocaleArtifact,
} from "../../scripts/native-app-i18n.ts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

type NativeTranslationArtifact = {
  entries: Array<{ id: string; source: string; translated: string }>;
  glossaryHash: string;
  locale: string;
  version: 1;
};

function artifactEntry(
  artifact: NativeTranslationArtifact,
  index: number,
  context: string,
): NativeTranslationArtifact["entries"][number] {
  return expectDefined(artifact.entries[index], context);
}

function sharedCatalogFixture(
  sourceEntries: readonly (readonly [string, string])[],
  translations: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [],
  descriptions: readonly (readonly [string, string])[] = [],
): ControlUiSharedCatalog {
  const source = new Map(sourceEntries);
  return {
    descriptions: new Map(descriptions),
    source,
    translations: new Map(translations.map(([locale, entries]) => [locale, new Map(entries)])),
  };
}

describe("native app i18n inventory", () => {
  it("keeps IDs stable across extractor classification changes", () => {
    const candidate = {
      kind: "ui-call",
      line: 10,
      path: "apps/ios/example.swift",
      source: "Gateway status",
      surface: "apple" as const,
    };
    const initial = assignNativeI18nIds([candidate]);
    const reclassified = { ...candidate, kind: "ui-call-multiline", line: 20 };

    expect(assignNativeI18nIds([reclassified])[0]?.id).toBe(initial[0]?.id);
    expect(initial[0]).not.toHaveProperty("line");
    expect(
      assignNativeI18nIds(
        [reclassified],
        [{ ...candidate, id: "native.apple.existing-translation" }],
      )[0]?.id,
    ).toBe("native.apple.existing-translation");
  });

  it("keeps registered ordering stable when extracted source lines move", () => {
    const candidates = [
      {
        kind: "ui-call",
        line: 10,
        path: "apps/ios/Settings.swift",
        source: "Zulu",
        surface: "apple" as const,
      },
      {
        kind: "ui-call",
        line: 20,
        path: "apps/ios/Settings.swift",
        source: "Alpha",
        surface: "apple" as const,
      },
    ];
    const previous: NativeI18nEntry[] = [
      {
        id: "native.apple.zulu",
        kind: "ui-call",
        path: candidates[0]!.path,
        source: "Zulu",
        surface: "apple",
      },
      {
        id: "native.apple.alpha",
        kind: "ui-call",
        path: candidates[1]!.path,
        source: "Alpha",
        surface: "apple",
      },
    ];

    const shifted = assignNativeI18nIds(
      [
        { ...candidates[1]!, line: 1 },
        { ...candidates[0]!, line: 999 },
      ],
      previous,
    );

    expect(shifted.map((entry) => entry.id)).toEqual(["native.apple.zulu", "native.apple.alpha"]);
    expect(shifted.every((entry) => !("line" in entry))).toBe(true);
  });

  it("preserves the registered ID and semantic identity when an unambiguous source moves", () => {
    const previous: NativeI18nEntry[] = [
      {
        id: "native.apple.registered",
        kind: "ui-call",
        path: "apps/ios/OldSettings.swift",
        semanticKey: "settings.connect",
        source: "Connect to Gateway",
        surface: "apple",
      },
    ];
    const [moved] = assignNativeI18nIds(
      [
        {
          kind: "ui-call",
          line: 42,
          path: "apps/ios/NewSettings.swift",
          source: "Connect to Gateway",
          surface: "apple",
        },
      ],
      previous,
    );

    expect(moved).toMatchObject({
      id: "native.apple.registered",
      semanticKey: "settings.connect",
    });
    expect(moved).not.toHaveProperty("line");
  });

  it("keeps Linux message IDs stable when their English wording changes", () => {
    const original = {
      description: "Gateway connection status while availability is being checked.",
      kind: "semantic-message",
      line: 0,
      path: "apps/linux/ui/messages.json",
      semanticKey: "desktop.gateway.checking",
      source: "Checking…",
      surface: "linux" as const,
    };
    const previous = assignNativeI18nIds([original]);
    const updated = assignNativeI18nIds([{ ...original, source: "Checking gateway…" }], previous);

    expect(updated[0]?.id).toBe(previous[0]?.id);
    expect(updated[0]).toMatchObject({
      description: original.description,
      semanticKey: original.semanticKey,
      source: "Checking gateway…",
      surface: "linux",
    });
    expect(updated[0]).not.toHaveProperty("line");
  });

  it("shares only explicitly reviewed concepts and persists authored translator context", () => {
    const shared = sharedCatalogFixture(
      [
        ["common.cancel", "Cancel"],
        ["action.open", "Open"],
        ["status.open", "Open"],
      ],
      [],
      [["common.cancel", "Dismiss the current operation without saving."]],
    );
    const entries = assignNativeI18nIds(
      [
        {
          kind: "ui-call",
          line: 10,
          path: "apps/ios/Settings.swift",
          source: "Cancel",
          surface: "apple",
        },
        {
          kind: "ui-call",
          line: 20,
          path: "apps/ios/Settings.swift",
          source: "Open",
          surface: "apple",
        },
      ],
      [],
      shared,
    );

    expect(entries.find((entry) => entry.source === "Cancel")).toMatchObject({
      description: "Dismiss the current operation without saving.",
      semanticKey: "common.cancel",
    });
    expect(entries.find((entry) => entry.source === "Open")).not.toHaveProperty("semanticKey");
  });

  it("rejects inferred Test and Local identities while deliberately mapping reviewed statuses", () => {
    const shared = sharedCatalogFixture([
      ["common.connected", "Connected"],
      ["another.connected", "Connected"],
      ["common.justNow", "just now"],
      ["common.loading", "Loading…"],
      ["usage.loading.badge", "Loading"],
      ["memoryPage.overview.health.test", "Test"],
      ["usage.filters.timeZoneLocal", "Local"],
    ]);
    const candidates = ["Connected", "just now", "Loading…", "Loading", "Test", "Local"].map(
      (source, index) => ({
        kind: "ui-call",
        line: index + 1,
        path: "apps/ios/Settings.swift",
        source,
        surface: "apple" as const,
      }),
    );
    const previous: NativeI18nEntry[] = [
      {
        id: "native.apple.old-test",
        kind: "ui-call",
        path: "apps/ios/Settings.swift",
        semanticKey: "memoryPage.overview.health.test",
        source: "Test",
        surface: "apple",
      },
      {
        id: "native.apple.old-local",
        kind: "ui-call",
        path: "apps/ios/Settings.swift",
        semanticKey: "usage.filters.timeZoneLocal",
        source: "Local",
        surface: "apple",
      },
    ];
    const entries = assignNativeI18nIds(candidates, previous, shared);
    const semanticKeys = new Map(entries.map((entry) => [entry.source, entry.semanticKey]));

    expect(semanticKeys.get("Connected")).toBe("common.connected");
    expect(semanticKeys.get("just now")).toBe("common.justNow");
    expect(semanticKeys.get("Loading…")).toBe("common.loading");
    expect(semanticKeys.get("Loading")).toBe("usage.loading.badge");
    expect(semanticKeys.get("Test")).toBeUndefined();
    expect(semanticKeys.get("Local")).toBeUndefined();
    expect(entries.find((entry) => entry.source === "Test")?.id).toBe("native.apple.old-test");
    expect(entries.find((entry) => entry.source === "Local")?.id).toBe("native.apple.old-local");
  });

  it("rejects reviewed semantic mappings after canonical English changes", () => {
    const candidate = {
      kind: "ui-call",
      line: 1,
      path: "apps/ios/Settings.swift",
      source: "Cancel",
      surface: "apple" as const,
    };
    const shared = sharedCatalogFixture([["common.cancel", "Discard"]]);

    expect(() => assignNativeI18nIds([candidate], [], shared)).toThrow(
      'reviewed native localization mapping common.cancel must equal "Cancel"',
    );
  });

  it("preserves registered IDs when Swift entries move between files", async () => {
    const entries = await collectNativeI18nEntries();
    const idsByLocation = new Map(
      entries.map((entry) => [`${entry.path}\0${entry.source}`, entry.id]),
    );
    const onboardingPath = "apps/ios/Sources/Onboarding/OnboardingWizardConnectionSections.swift";
    const sendingPath =
      "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel+Sending.swift";
    const movedEntries = [
      { id: "native.apple.95e2c98254da2aba", path: onboardingPath, source: "Home Network" },
      {
        id: "native.apple.d9a6d673aa6693ee",
        path: onboardingPath,
        source: "LAN or Tailscale host",
      },
      { id: "native.apple.431d02f8b68a96cf", path: onboardingPath, source: "Remote Domain" },
      { id: "native.apple.7021301971f631bf", path: onboardingPath, source: "VPS with domain" },
      {
        id: "native.apple.7451f8d052016642",
        path: onboardingPath,
        source: "Same Machine (Dev)",
      },
      {
        id: "native.apple.22e740296a762256",
        path: onboardingPath,
        source: "For local iOS app development",
      },
      {
        id: "native.apple.e1b1ccbfc9e73df8",
        path: onboardingPath,
        source: "Manual Connection",
      },
      { id: "native.apple.b7dc527c2a7e95cb", path: onboardingPath, source: "Continue" },
      {
        id: "native.apple.93d3e17fabd5e082",
        path: onboardingPath,
        source: "Developer mode",
      },
      {
        id: "native.apple.e8b90e582100294d",
        path: onboardingPath,
        source: "Connection Failed",
      },
      {
        id: "native.apple.9e208d090ce2e84f",
        path: onboardingPath,
        source: "Needs attention",
      },
      {
        id: "native.apple.e71e20089bcc4cfb",
        path: onboardingPath,
        source: "Ready to Connect",
      },
      { id: "native.apple.cf616b515da5bc19", path: onboardingPath, source: "Security" },
      {
        id: "native.apple.4014217851d06190",
        path: onboardingPath,
        source: "Plaintext (local network)",
      },
      {
        id: "native.apple.db7b52a1bbc6fac5",
        path: onboardingPath,
        source: "Use Manual Setup",
      },
      { id: "native.apple.7dbdf9a439f64f08", path: onboardingPath, source: "Setup Link" },
      {
        id: "native.apple.6bfb611862fb1687",
        path: onboardingPath,
        source:
          "Plaintext may expose credentials. Continue only if you trust this local network and host.",
      },
      {
        id: "native.apple.3329c7f367f10c78",
        path: onboardingPath,
        source: "Review this endpoint. Credentials are applied only after you tap Connect.",
      },
      {
        id: "native.apple.2f00ef4bc35ecb8d",
        path: onboardingPath,
        source: "No gateways found yet.",
      },
      {
        id: "native.apple.94c9697fb748d05d",
        path: onboardingPath,
        source: "Restart Discovery",
      },
      {
        id: "native.apple.07ebd3b75969629f",
        path: onboardingPath,
        source: "Discovered Gateways",
      },
      {
        id: "native.apple.2b45abdc56b2caed",
        path: sendingPath,
        source: "delivery unconfirmed",
      },
      {
        id: "native.apple.722f1f90b97e8e45",
        path: sendingPath,
        source: "queued after route change",
      },
    ];

    for (const entry of movedEntries) {
      expect(idsByLocation.get(`${entry.path}\0${entry.source}`)).toBe(entry.id);
    }
  });

  it("detects conditional branch identifiers without regex backtracking", () => {
    expect(isConditionalBranchIdentifier("isEnabled")).toBe(true);
    expect(isConditionalBranchIdentifier("hasFA2Enabled")).toBe(true);
    expect(isConditionalBranchIdentifier("abc123A")).toBe(false);
    expect(isConditionalBranchIdentifier("already_lowercase")).toBe(false);
    expect(isConditionalBranchIdentifier(`a${"A".repeat(4_096)}!`)).toBe(false);
  });

  it("joins adjacent literals across supported Swift and Kotlin UI expressions", () => {
    const swift = extractNativeI18nCandidates(
      "apple",
      "apps/ios/Fixture.swift",
      `
        struct Fixture: View {
          var body: some View {
            SettingsPageHeader(
              title: "Settings",
              subtitle: "Named " + "argument")
              .help("Modifier " + "details")
            Button("Swift first " + "argument") {}
            Text(enabled ? "Enabled " + "now" : "Disabled " + "now")
            Text(LocalizedStringKey("Localized key"))
            let count = 2
            Text(AttributedString(localized: "^[\\(count) entry](inflect: true)"))
          }

          var statusText: String {
            switch state {
            case .ready:
              "Switch " + "ready"
            default:
              return "Switch " + "waiting"
            }
          }
        }
      `,
      new Set(["Button", "SettingsPageHeader", "Text"]),
    );
    const kotlin = extractNativeI18nCandidates(
      "android",
      "apps/android/Fixture.kt",
      `
        @Composable
        fun Fixture() {
          Text("Kotlin first " + "argument")
          Text(text = "Named " + "argument")
          Icon(contentDescription = if (enabled) "Open \${row.title}" else row.title)
        }

        fun statusText(state: State): String = when (state) {
          State.Ready -> "When " + "ready"
          else -> "When " + "waiting"
        }

        fun messageText(enabled: Boolean): String {
          if (enabled) return "Return " + "enabled"
          return "Return " + "disabled"
        }

        fun warningText(summary: Summary): String =
          summary.warning ?: "Fallback warning"
      `,
    );
    const sources = [...swift, ...kotlin].map((entry) => entry.source);

    expect(sources).toEqual(
      expect.arrayContaining([
        "Named argument",
        "Modifier details",
        "Swift first argument",
        "Enabled now",
        "Disabled now",
        "Localized key",
        "^[\\(count) entry](inflect: true)",
        "Switch ready",
        "Switch waiting",
        "Kotlin first argument",
        "Open ${row.title}",
        "When ready",
        "When waiting",
        "Return enabled",
        "Return disabled",
        "Fallback warning",
      ]),
    );
    expect(
      sources.some((source) =>
        [
          "Named ",
          "Modifier ",
          "Enabled ",
          "Disabled ",
          "Switch ",
          "Swift first ",
          "Kotlin first ",
          "When ",
          "Return ",
        ].includes(source),
      ),
    ).toBe(false);
  });

  it("ignores generated Android resource entries", () => {
    const entries = extractNativeI18nCandidates(
      "android",
      "apps/android/app/src/main/res/values/strings.xml",
      `<resources>
        <string name="manual_status">Gateway ready</string>
        <string name="native_0123456789abcdef">Generated feedback</string>
      </resources>`,
    );

    expect(entries.map((entry) => entry.source)).toEqual(["Gateway ready"]);
  });

  it("extracts only localizable usage descriptions from Apple plists", () => {
    const entries = extractNativeI18nCandidates(
      "apple",
      "apps/ios/Fixture/Info.plist",
      `<plist><dict>
        <key>CFBundleDisplayName</key>
        <string>OpenClaw Fixture</string>
        <key>NSCameraUsageDescription</key>
        <string>OpenClaw uses the camera to scan setup codes &amp; documents.</string>
        <key>OpenClawFixtureValue</key>
        <string>Runtime configuration value</string>
      </dict></plist>`,
    );

    expect(entries.map((entry) => entry.source)).toEqual([
      "OpenClaw uses the camera to scan setup codes & documents.",
    ]);
  });

  it("respects non-translatable Android collections and retains lowercase choices", () => {
    const entries = extractNativeI18nCandidates(
      "android",
      "apps/android/app/src/main/res/values/wear.xml",
      `<resources>
        <string-array name="capabilities" translatable="false">
          <item>@string/native_capability</item>
          <item>openclaw_wear_companion_v1</item>
          <item>Visible choice</item>
        </string-array>
        <string-array name="modes">
          <item>@string/native_mode</item>
          <item>off</item>
          <item>Visible choice</item>
        </string-array>
      </resources>`,
    );

    expect(entries.map((entry) => entry.source)).toEqual(["off", "Visible choice"]);
  });

  it("collects stable Android, Apple, and source-owned Linux desktop UI entries", async () => {
    const entries = await collectNativeI18nEntries();
    const surfaces = new Set(entries.map((entry) => entry.surface));

    expect(entries.length).toBeGreaterThan(100);
    expect(surfaces).toEqual(new Set(["android", "apple", "linux"]));
    expect(entries.every((entry) => entry.id.startsWith(`native.${entry.surface}.`))).toBe(true);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(
      entries.every(
        (entry) => !/(?:\/|\\)(?:Tests?|UITests?|test|Preview(?:s)?)(?:\/|\\)/u.test(entry.path),
      ),
    ).toBe(true);
    expect(
      entries.every(
        (entry) => !/(?:Tests?|UITests?|Previews?|Testing)\.(?:swift|kt|kts)$/u.test(entry.path),
      ),
    ).toBe(true);
    expect(entries.every((entry) => !entry.path.endsWith("/NativeStringResources.kt"))).toBe(true);
    expect(
      entries
        .filter((entry) => entry.surface === "apple")
        .every((entry) =>
          /^(?:apps\/ios|apps\/macos\/Sources|apps\/shared\/OpenClawKit\/Sources)\//u.test(
            entry.path,
          ),
        ),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.surface === "android")
        .every(
          (entry) =>
            entry.path.startsWith("apps/android/app/src/main/") ||
            entry.path.startsWith("apps/android/app/src/play/") ||
            entry.path.startsWith("apps/android/app/src/thirdParty/") ||
            entry.path === "apps/android/wear/src/main/res/values/strings.xml",
        ),
    ).toBe(true);
    const linuxEntries = entries.filter((entry) => entry.surface === "linux");
    expect(linuxEntries.length).toBeGreaterThan(100);
    expect(
      linuxEntries.every(
        (entry) =>
          entry.path === "apps/linux/ui/messages.json" &&
          entry.kind === "semantic-message" &&
          entry.semanticKey?.startsWith("desktop.") &&
          entry.description,
      ),
    ).toBe(true);
    expect(linuxEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semanticKey: "desktop.gateway.installCli",
          source: "Install the OpenClaw CLI to continue.",
        }),
      ]),
    );
    expect(
      entries.some(
        (entry) =>
          entry.path === "apps/android/wear/src/main/res/values/strings.xml" &&
          entry.source === "Current session",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path.endsWith(
            "/thirdParty/java/ai/openclaw/app/ui/SensitivePhoneCapabilitiesSettings.kt",
          ) && entry.source === "Control other apps",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path.endsWith("/accessibility/AccessibilityDevActivity.kt") &&
          entry.source === "Accessibility executor",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "n${nodes.size}")).toBe(false);
    expect(entries.some((entry) => entry.source === "QR Scanner Unavailable")).toBe(true);
    expect(
      entries.some((entry) =>
        new Set(["Request ID: \\(value)", "Request ID: %@"]).has(entry.source),
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "Open ${row.title}")).toBe(true);
    expect(entries.some((entry) => entry.source === "Preview · $domain")).toBe(true);
    expect(entries.some((entry) => entry.source === "Approval command copied")).toBe(true);
    const androidSources = new Set(
      entries.filter((entry) => entry.surface === "android").map((entry) => entry.source),
    );
    expect([...androidSources]).toEqual(
      expect.arrayContaining([
        "A prior response already allowed this command and saved the choice.",
        "A prior response already allowed this command once.",
        "A prior response already resolved this approval.",
        "Approval allowed and saved.",
        "Approval allowed once.",
        "Gateway recorded approval and saved the choice.",
        "Gateway recorded approval once.",
        "Gateway recorded a denial.",
        "This approval expired before it could be resolved.",
        "This approval was cancelled before it could be resolved.",
        "Resolution outcome unknown. Actions stay disabled until the Gateway record is verified.",
        "The Gateway still shows this approval as pending. Review it before trying again.",
        "Could not load approval details. Refresh and try again.",
        "Could not load approvals.",
        "Could not resolve approval. Refresh and try again.",
        "Command request",
      ]),
    );
    expect(entries.some((entry) => entry.source === "Save Profile")).toBe(true);
    expect(entries.some((entry) => entry.source === "Mute")).toBe(true);
    expect(entries.some((entry) => entry.source === "Creating...")).toBe(true);
    expect(entries.some((entry) => entry.source === "Permission required")).toBe(true);
    expect(entries.some((entry) => entry.source === "Needs setup")).toBe(true);
    expect(
      entries.some(
        (entry) => entry.source === "Talk failed: Realtime provider closed unexpectedly.",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "Scan QR code")).toBe(true);
    expect(entries.some((entry) => entry.source === "Test connection")).toBe(true);
    expect(entries.some((entry) => entry.source === "Searching…")).toBe(true);
    expect(entries.some((entry) => entry.source === "Run now")).toBe(true);
    expect(entries.some((entry) => entry.source === "Loading chat")).toBe(true);
    expect(
      entries.some((entry) => entry.surface === "android" && entry.source === "Search OpenClaw"),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path.endsWith("/ChatMessageActions.kt") && entry.source === "Message actions",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) => entry.path.endsWith("/ChatMessageActions.kt") && entry.source === "Reply",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path.endsWith("/ChatMessageActions.kt") && entry.source === "Share message",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "What would you like to work on?")).toBe(true);
    expect(entries.some((entry) => entry.source === "Check OpenClaw status")).toBe(true);
    expect(entries.some((entry) => entry.source === "What can I control here?")).toBe(true);
    expect(entries.some((entry) => entry.source === "Help me start voice chat")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Summarize the current OpenClaw status and tell me what needs attention.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Show me which phone controls and device capabilities are available right now.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) => entry.source === "Help me start a realtime voice session from this phone.",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "DIARY")).toBe(true);
    expect(entries.some((entry) => entry.source === "ask OpenClaw $prompt")).toBe(true);
    expect(entries.some((entry) => entry.source === "OpenClaw is paused")).toBe(true);
    expect(
      entries.some((entry) => entry.source === "Choose system, light, or dark appearance"),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path === "apps/ios/Sources/Design/TalkRuntimeIssueBanner.swift" &&
          entry.source === "Details",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path === "apps/ios/Sources/Design/TalkRuntimeIssueBanner.swift" &&
          entry.source === "Open Settings",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "No threads yet")).toBe(true);
    expect(
      entries.some(
        (entry) => entry.path.endsWith("/ChatSheets.swift") && entry.source === "Search threads",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "Don't show this again")).toBe(true);
    expect(entries.some((entry) => entry.source === "Use Manual Gateway")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Direct mode supports device info, status, and notifications. Chat, Talk, and approvals still use the iPhone.",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "Session target")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source === 'OpenClaw needs ${labels.joinToString(", ")} permissions to continue.',
      ),
    ).toBe(true);
    expect(
      entries.some((entry) => entry.source === "Some channel status checks did not complete."),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Your AI-powered setup helper. It can check status, fix config, switch models, and connect channels.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Cron changes require operator.admin. Setup codes intentionally do not grant it. Reconnect with the gateway's shared token or password to request admin access. If this device still lacks it, approve the pending scope upgrade from an existing admin client.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Writes a rotating, local-only log under ~/Library/Logs/OpenClaw/. Enable only while actively debugging.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Paste the token configured on the gateway host. On the gateway host, run `openclaw gateway auth-token --show` in an interactive terminal, then paste its output.",
      ),
    ).toBe(true);
    expect(
      entries.some((entry) =>
        [
          "Your AI-powered setup helper. It can check status, fix config, ",
          "Cron changes require operator.admin. Setup codes intentionally do not grant it. ",
          "Writes a rotating, local-only log under ~/Library/Logs/OpenClaw/. ",
          "Paste the token configured on the gateway host. ",
        ].includes(entry.source),
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.source === '\\(day.entryCount) \\(day.entryCount == 1 ? "entry" : "entries")',
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.source === 'Missing binaries: \\(self.missingBins.joined(separator: ", "))',
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Approve this device on the gateway.\n1) `%1$@`\n2) `/pair approve` in your OpenClaw chat\n%2$@\nOpenClaw will also retry automatically when you return to this app.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path === "apps/ios/Sources/Gateway/GatewayConnectionController.swift" &&
          entry.kind === "ui-localized-call-multiline" &&
          entry.source ===
            "Enable Gateway TLS, or enter your Tailscale Serve HTTPS host in Manual Setup. Use Unencrypted only with a trusted private-LAN address.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path === "apps/ios/Sources/Gateway/GatewayConnectionController.swift" &&
          entry.kind === "ui-localized-call-multiline" &&
          entry.source ===
            "Can't reach gateway at %1$@:%2$@. Verify Tailscale Serve is enabled and publishes this Gateway.",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "Approve this device on the gateway.\n")).toBe(
      false,
    );
    expect(
      entries.some((entry) =>
        entry.source.startsWith(
          "Exec approvals can only be reviewed while OpenClaw is open and connected.",
        ),
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "$(PRODUCT_BUNDLE_IDENTIFIER)")).toBe(false);
    expect(entries.some((entry) => entry.source === "ai.openclaw.screenRecord.writer")).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.surface === "android" && entry.source === "INVALID_REQUEST: expected JSON object",
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.surface === "android" && ["off", "talk-orb", "pulse"].includes(entry.source),
      ),
    ).toBe(false);
    expect(entries.some((entry) => entry.source === "false")).toBe(false);
    expect(entries.some((entry) => entry.source === "ws")).toBe(false);
    expect(entries.some((entry) => entry.source === '{"includeSecrets":true}')).toBe(false);
    expect(entries.some((entry) => entry.source === "builtIn")).toBe(false);
    expect(entries.some((entry) => entry.source === "State:  \\(stateDir)")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Direct mode supports device info, status, and notifications. Chat, Talk, and approvals still use the iPhone.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "The watch receives a one-time pairing code and stores its own device token. A reachable secure Gateway URL is required away from the iPhone.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "Starts enabled. After this Mac is paired and macOS access is granted, the paired Gateway can move the pointer, click, and type without per-action confirmation. High risk.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "The details are listed on each option above. You can fix the login and retry, or connect with an API key or token below.",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.path.endsWith("Info.plist"))).toBe(true);
    expect(NATIVE_I18N_LOCALES).toHaveLength(21);
    expect(NATIVE_I18N_LOCALES).toContain("sv");
  });

  it("translates Linux desktop semantic messages with authored context and ICU arguments", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-linux-i18n-");
    const entries: NativeI18nEntry[] = [
      {
        description: "Number of gateways discovered on the local network.",
        id: "native.linux.discovery-found",
        kind: "semantic-message",
        path: "apps/linux/ui/messages.json",
        semanticKey: "desktop.main.discoveryFound",
        source: "{count} FOUND",
        surface: "linux",
      },
    ];
    const shared = sharedCatalogFixture([["desktop.main.discoveryFound", "{count} FOUND"]]);

    try {
      const result = await syncNativeLocale("sv", entries, {
        glossary: [],
        sharedCatalog: shared,
        translationsDir,
        translate: async (pending) => {
          expect(pending).toEqual([
            expect.objectContaining({
              description: "Number of gateways discovered on the local network.",
              id: "native.linux.discovery-found",
              semanticKey: "desktop.main.discoveryFound",
              sourcePath: "apps/linux/ui/messages.json",
            }),
          ]);
          return new Map([["native.linux.discovery-found", "{count} HITTADE"]]);
        },
      });
      const artifact = JSON.parse(
        await readFile(path.join(translationsDir, "sv.json"), "utf8"),
      ) as NativeTranslationArtifact;

      expect(result).toEqual({ changed: true, translated: 1 });
      expect(artifact.entries[0]).toEqual({
        id: "native.linux.discovery-found",
        source: "{count} FOUND",
        translated: "{count} HITTADE",
      });
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("does not borrow a reviewed web translation for a different Linux semantic key", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-linux-i18n-identity-");
    const entries: NativeI18nEntry[] = [
      {
        description: "Connection status for this desktop Gateway.",
        id: "native.linux.gateway-connected",
        kind: "semantic-message",
        path: "apps/linux/ui/messages.json",
        semanticKey: "desktop.gateway.connected",
        source: "Connected",
        surface: "linux",
      },
    ];
    const shared = sharedCatalogFixture(
      [
        ["common.connected", "Connected"],
        ["desktop.gateway.connected", "Connected"],
      ],
      [["de", [["common.connected", "Verbunden"]]]],
    );

    try {
      const result = await syncNativeLocale("de", entries, {
        glossary: [],
        sharedCatalog: shared,
        translationsDir,
        translate: async (pending) => {
          expect(pending).toEqual([
            expect.objectContaining({
              id: "native.linux.gateway-connected",
              semanticKey: "desktop.gateway.connected",
            }),
          ]);
          return new Map([["native.linux.gateway-connected", "Gateway verbunden"]]);
        },
      });
      const artifact = JSON.parse(
        await readFile(path.join(translationsDir, "de.json"), "utf8"),
      ) as NativeTranslationArtifact;

      expect(result).toEqual({ changed: true, translated: 1 });
      expect(artifact.entries[0]?.translated).toBe("Gateway verbunden");
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("reuses an exact shared web translation without invoking the translation provider", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-shared-");
    const entries: NativeI18nEntry[] = [
      {
        id: "native.apple.cancel",
        kind: "ui-call",
        path: "apps/ios/Settings.swift",
        semanticKey: "common.cancel",
        source: "Cancel",
        surface: "apple",
      },
    ];
    const shared = sharedCatalogFixture(
      [["common.cancel", "Cancel"]],
      [["sv", [["common.cancel", "Avbryt"]]]],
    );

    try {
      const result = await syncNativeLocale("sv", entries, {
        glossary: [],
        sharedCatalog: shared,
        translationsDir,
        translate: async () => {
          throw new Error("a verified shared translation must not invoke the provider");
        },
      });
      const artifact = JSON.parse(
        await readFile(path.join(translationsDir, "sv.json"), "utf8"),
      ) as NativeTranslationArtifact;

      expect(result).toEqual({ changed: true, translated: 0 });
      expect(artifact.entries).toEqual([
        { id: "native.apple.cancel", source: "Cancel", translated: "Avbryt" },
      ]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("refreshes reviewed German shared translations without overwriting unmapped native copy", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-reviewed-");
    const entries: NativeI18nEntry[] = [
      {
        id: "native.android.loading",
        kind: "ui-call",
        path: "apps/android/Settings.kt",
        semanticKey: "usage.loading.badge",
        source: "Loading",
        surface: "android",
      },
      {
        id: "native.apple.just-now",
        kind: "ui-call",
        path: "apps/ios/Settings.swift",
        semanticKey: "common.justNow",
        source: "just now",
        surface: "apple",
      },
      {
        id: "native.apple.test",
        kind: "ui-call",
        path: "apps/macos/Sources/OpenClaw/DebugSettings.swift",
        source: "Test",
        surface: "apple",
      },
    ];
    const glossaryHash = createHash("sha256").update(JSON.stringify([])).digest("hex");
    const artifactPath = path.join(translationsDir, "de.json");
    const createSharedCatalog = (loading: string, justNow: string) =>
      sharedCatalogFixture(
        [
          ["usage.loading.badge", "Loading"],
          ["common.justNow", "just now"],
          ["memoryPage.overview.health.test", "Test"],
        ],
        [
          [
            "de",
            [
              ["usage.loading.badge", loading],
              ["common.justNow", justNow],
              ["memoryPage.overview.health.test", "Prüfen"],
            ],
          ],
        ],
      );

    try {
      await writeFile(
        artifactPath,
        `${JSON.stringify(
          {
            version: 1,
            locale: "de",
            glossaryHash,
            entries: [
              { id: "native.android.loading", source: "Loading", translated: "Loading" },
              { id: "native.apple.just-now", source: "just now", translated: "soeben" },
              { id: "native.apple.test", source: "Test", translated: "Testlauf" },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const failProvider = async () => {
        throw new Error("reviewed shared translation refresh must not invoke the provider");
      };
      const first = await syncNativeLocale("de", entries, {
        glossary: [],
        sharedCatalog: createSharedCatalog("Wird geladen", "gerade eben"),
        translationsDir,
        translate: failProvider,
      });
      const initial = JSON.parse(await readFile(artifactPath, "utf8")) as NativeTranslationArtifact;

      expect(first).toEqual({ changed: true, translated: 0 });
      expect(initial.entries.map((entry) => entry.translated)).toEqual([
        "Wird geladen",
        "gerade eben",
        "Testlauf",
      ]);

      const refreshed = await syncNativeLocale("de", entries, {
        glossary: [],
        sharedCatalog: createSharedCatalog("Ladevorgang läuft", "soeben aktualisiert"),
        translationsDir,
        translate: failProvider,
      });
      const updated = JSON.parse(await readFile(artifactPath, "utf8")) as NativeTranslationArtifact;

      expect(refreshed).toEqual({ changed: true, translated: 0 });
      expect(updated.entries.map((entry) => entry.translated)).toEqual([
        "Ladevorgang läuft",
        "soeben aktualisiert",
        "Testlauf",
      ]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("does not reuse a different semantic translation for ambiguous identical English", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-context-");
    const entries: NativeI18nEntry[] = [
      {
        id: "native.apple.open-status",
        kind: "conditional-branch",
        path: "apps/ios/Status.swift",
        semanticKey: "status.open",
        source: "Open",
        surface: "apple",
      },
    ];
    const shared = sharedCatalogFixture(
      [
        ["action.open", "Open"],
        ["status.open", "Open"],
      ],
      [["sv", [["action.open", "Öppna"]]]],
    );

    try {
      const result = await syncNativeLocale("sv", entries, {
        glossary: [],
        sharedCatalog: shared,
        translationsDir,
        translate: async (pending) => {
          expect(pending).toEqual([
            expect.objectContaining({
              description: "Apple conditional branch in Status.swift",
              id: "native.apple.open-status",
              semanticKey: "status.open",
              sourcePath: "apps/ios/Status.swift",
            }),
          ]);
          return new Map([["native.apple.open-status", "Öppen"]]);
        },
      });
      const artifact = JSON.parse(
        await readFile(path.join(translationsDir, "sv.json"), "utf8"),
      ) as NativeTranslationArtifact;

      expect(result).toEqual({ changed: true, translated: 1 });
      expect(artifact.entries[0]?.translated).toBe("Öppen");
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("translates one shared semantic message once across Android and Apple", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-dedup-");
    const entries: NativeI18nEntry[] = [
      {
        id: "native.android.retry",
        kind: "ui-call",
        path: "apps/android/Settings.kt",
        semanticKey: "common.retry",
        source: "Retry",
        surface: "android",
      },
      {
        id: "native.apple.retry",
        kind: "ui-call",
        path: "apps/ios/Settings.swift",
        semanticKey: "common.retry",
        source: "Retry",
        surface: "apple",
      },
    ];
    const shared = sharedCatalogFixture([["common.retry", "Retry"]]);

    try {
      const result = await syncNativeLocale("sv", entries, {
        glossary: [],
        sharedCatalog: shared,
        translationsDir,
        translate: async (pending) => {
          expect(pending).toHaveLength(1);
          expect(pending[0]).toMatchObject({
            id: "native.android.retry",
            semanticKey: "common.retry",
          });
          return new Map([["native.android.retry", "Försök igen"]]);
        },
      });
      const artifact = JSON.parse(
        await readFile(path.join(translationsDir, "sv.json"), "utf8"),
      ) as NativeTranslationArtifact;

      expect(result).toEqual({ changed: true, translated: 2 });
      expect(artifact.entries.map((entry) => entry.translated)).toEqual([
        "Försök igen",
        "Försök igen",
      ]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("creates a first-run locale artifact and leaves a complete artifact unchanged", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-");
    const entries: NativeI18nEntry[] = [
      {
        id: "native.android.hello",
        kind: "ui-call",
        path: "apps/android/example.kt",
        source: "Hello",
        surface: "android",
      },
      {
        id: "native.apple.request",
        kind: "ui-call",
        path: "apps/ios/example.swift",
        source: "Request ID: \\(requestId)",
        surface: "apple",
      },
      {
        id: "native.android.count",
        kind: "ui-call",
        path: "apps/android/example.kt",
        source: "Showing ${visibleApps.size} of ${apps.size}",
        surface: "android",
      },
      {
        id: "native.apple.permissions",
        kind: "ui-call",
        path: "apps/ios/example.swift",
        source: "\\(granted) of \\(total) permissions granted",
        surface: "apple",
      },
    ];

    try {
      const first = await syncNativeLocale("sv", entries, {
        glossary: [],
        translationsDir,
        translate: async (pending) =>
          new Map(
            pending.map((entry) => {
              const translated = {
                "native.android.hello": "Hej",
                "native.apple.request": "Begärans-ID: \\(requestId)",
                "native.android.count": "${apps.size} totalt, ${visibleApps.size} visas",
                "native.apple.permissions": "Av \\(total) behörigheter har \\(granted) beviljats",
              }[entry.id];
              return [entry.id, translated ?? entry.source];
            }),
          ),
      });
      expect(first).toEqual({ changed: true, translated: 4 });

      const artifactPath = path.join(translationsDir, "sv.json");
      const firstContents = await readFile(artifactPath, "utf8");
      const firstModifiedAt = (await stat(artifactPath)).mtimeMs;
      const second = await syncNativeLocale("sv", entries, {
        glossary: [],
        translationsDir,
        translate: async () => {
          throw new Error("no-op refresh must not call the provider");
        },
      });

      expect(second).toEqual({ changed: false, translated: 0 });
      expect(await readFile(artifactPath, "utf8")).toBe(firstContents);
      expect((await stat(artifactPath)).mtimeMs).toBe(firstModifiedAt);

      const movedEntries = entries.map((entry) => ({
        ...entry,
        id: `${entry.id}.moved`,
      }));
      const moved = await syncNativeLocale("sv", movedEntries, {
        glossary: [],
        translationsDir,
        translate: async (pending) =>
          new Map(pending.map((entry) => [entry.id, `moved:${entry.source}`])),
      });
      expect(moved).toEqual({ changed: true, translated: 4 });
      const movedArtifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
        entries: Array<{ id: string; source: string; translated: string }>;
      };
      expect(movedArtifact.entries.map((entry) => entry.id)).toEqual(
        movedEntries.map((entry) => entry.id),
      );
      expect(movedArtifact.entries.map((entry) => entry.translated)).toEqual([
        "moved:Hello",
        "moved:Request ID: \\(requestId)",
        "moved:Showing ${visibleApps.size} of ${apps.size}",
        "moved:\\(granted) of \\(total) permissions granted",
      ]);

      const refreshed = await syncNativeLocale("sv", entries, {
        glossary: [{ source: "Request", target: "Begäran" }],
        translationsDir,
        translate: async (pending) =>
          new Map(pending.map((entry) => [entry.id, `refreshed:${entry.source}`])),
      });

      expect(refreshed).toEqual({ changed: true, translated: 4 });
      const refreshedArtifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
        entries: Array<{ translated: string }>;
        glossaryHash: string;
      };
      expect(refreshedArtifact.glossaryHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(
        refreshedArtifact.entries.every((entry) => entry.translated.startsWith("refreshed:")),
      ).toBe(true);

      const fallbackEntries = [
        {
          id: "native.apple.fallback",
          kind: "ui-call",
          path: "apps/ios/example.swift",
          source: "Try again",
          surface: "apple",
        },
      ] satisfies NativeI18nEntry[];
      await writeFile(
        artifactPath,
        `${JSON.stringify(
          {
            version: 1,
            locale: "sv",
            glossaryHash: refreshedArtifact.glossaryHash,
            entries: [
              {
                id: "native.apple.fallback.previous",
                source: fallbackEntries[0]!.source,
                translated: fallbackEntries[0]!.source,
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const retried = await syncNativeLocale("sv", fallbackEntries, {
        glossary: [{ source: "Request", target: "Begäran" }],
        translationsDir,
        translate: async (pending) => new Map(pending.map((entry) => [entry.id, "Försök igen"])),
      });
      expect(retried).toEqual({ changed: true, translated: 1 });

      const ambiguousEntries = [
        {
          id: "native.apple.ambiguous.current",
          kind: "ui-call",
          path: "apps/ios/example.swift",
          source: "Open",
          surface: "apple",
        },
      ] satisfies NativeI18nEntry[];
      await writeFile(
        artifactPath,
        `${JSON.stringify(
          {
            version: 1,
            locale: "sv",
            glossaryHash: refreshedArtifact.glossaryHash,
            entries: [
              {
                id: "native.apple.ambiguous.action",
                source: "Open",
                translated: "Öppna",
              },
              {
                id: "native.apple.ambiguous.state",
                source: "Open",
                translated: "Öppen",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const ambiguous = await syncNativeLocale("sv", ambiguousEntries, {
        glossary: [{ source: "Request", target: "Begäran" }],
        translationsDir,
        translate: async (pending) =>
          new Map(pending.map((entry) => [entry.id, "Öppna i aktuell kontext"])),
      });
      expect(ambiguous).toEqual({ changed: true, translated: 1 });
      const ambiguousArtifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
        entries: Array<{ translated: string }>;
      };
      expect(ambiguousArtifact.entries[0]?.translated).toBe("Öppna i aktuell kontext");

      const partialChurnEntries = [
        {
          id: "native.apple.partial.action.current",
          kind: "ui-call",
          path: "apps/ios/action.swift",
          source: "Open",
          surface: "apple",
        },
        {
          id: "native.apple.partial.state.current",
          kind: "ui-call",
          path: "apps/ios/state.swift",
          source: "Open",
          surface: "apple",
        },
      ] satisfies NativeI18nEntry[];
      await writeFile(
        artifactPath,
        `${JSON.stringify(
          {
            version: 1,
            locale: "sv",
            glossaryHash: refreshedArtifact.glossaryHash,
            entries: [
              {
                id: "native.apple.partial.action.previous",
                source: "Open",
                translated: "Öppna",
              },
              {
                id: "native.apple.partial.state.previous",
                source: "Open",
                translated: "Open",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const partialChurn = await syncNativeLocale("sv", partialChurnEntries, {
        glossary: [{ source: "Request", target: "Begäran" }],
        translationsDir,
        translate: async (pending) =>
          new Map(pending.map((entry, index) => [entry.id, `Översatt ${index + 1}`])),
      });
      expect(partialChurn).toEqual({ changed: true, translated: 2 });
      const partialChurnArtifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
        entries: Array<{ translated: string }>;
      };
      expect(partialChurnArtifact.entries.map((entry) => entry.translated)).toEqual([
        "Översatt 1",
        "Översatt 2",
      ]);

      const duplicateEntries = [
        {
          id: "native.apple.open.action",
          kind: "ui-call",
          path: "apps/ios/action.swift",
          source: "Open",
          surface: "apple",
        },
        {
          id: "native.apple.open.state",
          kind: "ui-call",
          path: "apps/ios/state.swift",
          source: "Open",
          surface: "apple",
        },
      ] satisfies NativeI18nEntry[];
      await writeFile(
        artifactPath,
        `${JSON.stringify(
          {
            version: 1,
            locale: "sv",
            glossaryHash: refreshedArtifact.glossaryHash,
            entries: [
              {
                id: "native.apple.open.action",
                source: "Open",
                translated: "Öppna",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const duplicate = await syncNativeLocale("sv", duplicateEntries, {
        glossary: [{ source: "Request", target: "Begäran" }],
        translationsDir,
        translate: async (pending) => new Map(pending.map((entry) => [entry.id, "Öppen"])),
      });
      expect(duplicate).toEqual({ changed: true, translated: 1 });
      const duplicateArtifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
        entries: Array<{ id: string; translated: string }>;
      };
      expect(duplicateArtifact.entries).toEqual([
        { id: "native.apple.open.action", source: "Open", translated: "Öppna" },
        { id: "native.apple.open.state", source: "Open", translated: "Öppen" },
      ]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("rejects native printf placeholder drift", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-");
    const cases = [
      {
        entry: {
          id: "native.android.certificate",
          kind: "ui-call",
          path: "apps/android/example.kt",
          source: "Old fingerprint: %1$s\nNew fingerprint: %2$s",
          surface: "android",
        },
        translated: "Gammalt fingeravtryck: %1$s",
      },
      {
        entry: {
          id: "native.apple.failure",
          kind: "ui-call",
          path: "apps/ios/example.swift",
          source: "Send failed: %@",
          surface: "apple",
        },
        translated: "Sändningen misslyckades",
      },
      {
        entry: {
          id: "native.apple.percent",
          kind: "ui-call",
          path: "apps/ios/example.swift",
          source: "Context %@%% used",
          surface: "apple",
        },
        translated: "Kontext %@ används",
      },
      {
        entry: {
          id: "native.linux.discovery",
          kind: "semantic-message",
          path: "apps/linux/ui/messages.json",
          semanticKey: "desktop.main.discoveryFound",
          source: "{count} FOUND",
          surface: "linux",
        },
        translated: "{total} HITTADE",
      },
    ] satisfies Array<{ entry: NativeI18nEntry; translated: string }>;

    try {
      for (const { entry, translated } of cases) {
        await expect(
          syncNativeLocale("sv", [entry], {
            glossary: [],
            translationsDir,
            translate: async () => new Map([[entry.id, translated]]),
          }),
        ).rejects.toThrow(
          `native translation changed placeholders or line breaks for sv:${entry.id}`,
        );
      }
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("rejects invalid locale artifact metadata, inventory, and translations", () => {
    const inventory: NativeI18nEntry[] = [
      {
        id: "native.android.greeting",
        kind: "ui-call",
        path: "apps/android/Greeting.kt",
        source: "Hello ${name}\nNext",
        surface: "android",
      },
      {
        id: "native.apple.other",
        kind: "ui-call",
        path: "apps/ios/Other.swift",
        source: "Other",
        surface: "apple",
      },
    ];
    const greeting = expectDefined(inventory[0], "native greeting inventory entry");
    const other = expectDefined(inventory[1], "native other inventory entry");
    const emptyGlossaryHash = createHash("sha256").update(JSON.stringify([])).digest("hex");
    const createArtifact = (): NativeTranslationArtifact => ({
      version: 1,
      locale: "sv",
      glossaryHash: emptyGlossaryHash,
      entries: [
        {
          id: greeting.id,
          source: greeting.source,
          translated: "Hej ${name}\nNästa",
        },
        {
          id: other.id,
          source: other.source,
          translated: "Annat",
        },
      ],
    });
    const cases: Array<{
      expected: string;
      mutate: (artifact: NativeTranslationArtifact) => unknown;
    }> = [
      {
        expected: "version must be 1",
        mutate: (artifact) => ({ ...artifact, version: 2 }),
      },
      {
        expected: 'locale must be "sv"',
        mutate: (artifact) => ({ ...artifact, locale: "de" }),
      },
      {
        expected: "glossaryHash must be",
        mutate: (artifact) => ({ ...artifact, glossaryHash: "stale" }),
      },
      {
        expected: "entry count must be 2, got 1",
        mutate: (artifact) => ({ ...artifact, entries: artifact.entries.slice(0, 1) }),
      },
      {
        expected: 'entries[0].id must be "native.android.greeting"',
        mutate: (artifact) => ({ ...artifact, entries: artifact.entries.toReversed() }),
      },
      {
        expected: "entries[0].source does not match inventory",
        mutate: (artifact) => ({
          ...artifact,
          entries: [
            { ...artifactEntry(artifact, 0, "first native translation entry"), source: "Changed" },
            artifactEntry(artifact, 1, "second native translation entry"),
          ],
        }),
      },
      {
        expected: 'duplicate id "native.android.greeting"',
        mutate: (artifact) => ({
          ...artifact,
          entries: [
            artifactEntry(artifact, 0, "first duplicate native translation entry"),
            {
              ...artifactEntry(artifact, 1, "second duplicate native translation entry"),
              id: artifactEntry(artifact, 0, "duplicate native translation source entry").id,
            },
          ],
        }),
      },
      {
        expected: "entries[1].translated must be nonempty",
        mutate: (artifact) => ({
          ...artifact,
          entries: [
            artifactEntry(artifact, 0, "first nonempty native translation entry"),
            {
              ...artifactEntry(artifact, 1, "second nonempty native translation entry"),
              translated: "  ",
            },
          ],
        }),
      },
      {
        expected: "translation changed structural tokens or line breaks",
        mutate: (artifact) => ({
          ...artifact,
          entries: [{ ...artifact.entries[0], translated: "Hej\nNästa" }, artifact.entries[1]],
        }),
      },
      {
        expected: "translation changed structural tokens or line breaks",
        mutate: (artifact) => ({
          ...artifact,
          entries: [
            {
              ...artifactEntry(artifact, 0, "first structural native translation entry"),
              translated: "Hej ${name} Nästa",
            },
            artifactEntry(artifact, 1, "second structural native translation entry"),
          ],
        }),
      },
    ];

    expect(validateNativeLocaleArtifact("sv", inventory, createArtifact())).toEqual([]);
    for (const testCase of cases) {
      expect(() =>
        validateNativeLocaleArtifact("sv", inventory, testCase.mutate(createArtifact())),
      ).toThrow(testCase.expected);
    }
  });

  it("emits deterministic advisory translation-quality findings", () => {
    const inventory: NativeI18nEntry[] = [
      {
        id: "native.android.language-picker",
        kind: "conditional-branch",
        path: "apps/android/app/src/main/java/ai/openclaw/app/AppLanguage.kt",
        source: "OpenClaw translations · $languageTag",
        surface: "android",
      },
      {
        id: "native.android.inspect",
        kind: "ui-call",
        path: "apps/android/Workshop.kt",
        source: "Inspect",
        surface: "android",
      },
      {
        id: "native.apple.inspect",
        kind: "ui-call",
        path: "apps/ios/Workshop.swift",
        source: "Inspect",
        surface: "apple",
      },
      {
        id: "native.android.voice-note",
        kind: "ui-call",
        path: "apps/android/Voice.kt",
        source: "Record voice note",
        surface: "android",
      },
    ];
    const languagePicker = expectDefined(inventory[0], "native language picker inventory entry");
    const androidInspect = expectDefined(inventory[1], "native Android inspect inventory entry");
    const appleInspect = expectDefined(inventory[2], "native Apple inspect inventory entry");
    const voiceNote = expectDefined(inventory[3], "native voice note inventory entry");
    const artifact: NativeTranslationArtifact = {
      version: 1,
      locale: "id",
      glossaryHash: createHash("sha256").update(JSON.stringify([])).digest("hex"),
      entries: [
        {
          id: languagePicker.id,
          source: languagePicker.source,
          translated: languagePicker.source,
        },
        {
          id: androidInspect.id,
          source: androidInspect.source,
          translated: androidInspect.source,
        },
        {
          id: appleInspect.id,
          source: appleInspect.source,
          translated: "Periksa",
        },
        {
          id: voiceNote.id,
          source: voiceNote.source,
          translated: "Ghi ghi chú thoại",
        },
      ],
    };

    const findings = validateNativeLocaleArtifact("id", inventory, artifact);
    expect(findings.map((finding) => `${finding.code}:${finding.id}`)).toEqual([
      "adjacent-duplicate-word:native.android.voice-note",
      "android-language-picker-source-equal:native.android.language-picker",
      "same-source-contradiction:native.android.inspect",
      "source-equal:native.android.inspect",
      "source-equal:native.android.language-picker",
    ]);
    expect(findings[0]?.words).toEqual(["ghi"]);
    expect(findings[2]?.relatedIds).toEqual(["native.apple.inspect"]);
  });

  it("validates locale refresh arguments before write paths run", () => {
    expect(parseNativeI18nCommand(["baseline", "--write"])).toEqual({
      command: "baseline",
      locale: undefined,
      write: true,
    });
    expect(parseNativeI18nCommand(["verify"])).toEqual({
      command: "verify",
      locale: undefined,
      write: false,
    });
    expect(parseNativeI18nCommand(["sync", "--write", "--locale", "sv"])).toEqual({
      command: "sync",
      locale: "sv",
      write: true,
    });
    expect(() => parseNativeI18nCommand(["sync", "--write", "--locale"])).toThrow(
      "requires a locale value",
    );
    expect(() => parseNativeI18nCommand(["sync", "--write", "--locale", "--write"])).toThrow(
      "requires a locale value",
    );
    expect(() => parseNativeI18nCommand(["sync", "--write", "--locale", "xx"])).toThrow(
      "unsupported native locale",
    );
    expect(() => parseNativeI18nCommand(["check", "--locale", "sv"])).toThrow(
      "requires `sync --write",
    );
    expect(() => parseNativeI18nCommand(["baseline"])).toThrow("requires `--write`");
    expect(() => parseNativeI18nCommand(["verify", "--write"])).toThrow(
      "does not accept `--write`",
    );
  });
});
