import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { buildMacosCatalog } from "../../scripts/apple-app-i18n.ts";
import {
  assignNativeI18nIds,
  collectNativeI18nEntries,
  extractNativeI18nCandidates,
  isConditionalBranchIdentifier,
  NATIVE_I18N_LOCALES,
  parseNativeI18nCommand,
  serializeNativeI18nInventory,
  syncNativeLocale,
  type NativeI18nEntry,
  validateNativeLocaleArtifact,
} from "../../scripts/native-app-i18n.ts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

type NativeTranslationArtifact = {
  glossaryHash: string;
  locale: string;
  translations: Record<string, string>;
  version: 2;
};

function testEntry(
  id: string,
  surface: "android" | "apple",
  source: string,
  sitePath = `apps/${surface}/Fixture.${surface === "apple" ? "swift" : "kt"}`,
  kind = "ui-call",
): NativeI18nEntry {
  return { id, source, surface, sites: [{ kind, path: sitePath }] };
}

function hasSite(
  entry: NativeI18nEntry,
  predicate: (site: NativeI18nEntry["sites"][number]) => boolean,
): boolean {
  return entry.sites.some(predicate);
}

describe("native app i18n inventory", () => {
  it("serializes each complete entry on one line", () => {
    const entries = [
      {
        id: "native.android.fixture",
        source: 'A quoted "label"\nwith two lines',
        surface: "android",
        sites: [
          { kind: "xml-string", path: "apps/android/res/values/strings.xml" },
          { kind: "ui-call", path: "apps/android/src/Fixture.kt" },
        ],
      },
      {
        id: "native.apple.fixture",
        source: "Settings",
        surface: "apple",
        sites: [{ kind: "ui-call", path: "apps/ios/Sources/Fixture.swift" }],
      },
    ] satisfies NativeI18nEntry[];

    const serialized = serializeNativeI18nInventory(entries);
    const lines = serialized.trimEnd().split("\n");

    expect(JSON.parse(serialized)).toEqual({ version: 2, entries });
    expect(lines).toHaveLength(entries.length + 5);
    expect(lines.slice(3, -2)).toEqual([
      `    ${JSON.stringify(entries[0])},`,
      `    ${JSON.stringify(entries[1])}`,
    ]);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("merges sites and hashes only surface plus source", () => {
    const source = "Gateway status";
    const entries = assignNativeI18nIds([
      {
        kind: "ui-modifier",
        line: 20,
        path: "apps/ios/Zeta.swift",
        source,
        surface: "apple",
      },
      {
        kind: "ui-call",
        line: 10,
        path: "apps/ios/Alpha.swift",
        source,
        surface: "apple",
      },
    ]);
    const expectedId = `native.apple.${createHash("sha256").update(`apple ${source}`).digest("hex").slice(0, 16)}`;

    expect(entries).toEqual([
      {
        id: expectedId,
        source,
        surface: "apple",
        sites: [
          { kind: "ui-call", path: "apps/ios/Alpha.swift" },
          { kind: "ui-modifier", path: "apps/ios/Zeta.swift" },
        ],
      },
    ]);
    expect(
      assignNativeI18nIds([
        {
          kind: "ui-call-multiline",
          line: 99,
          path: "apps/ios/Moved.swift",
          source,
          surface: "apple",
        },
      ])[0]?.id,
    ).toBe(expectedId);
  });

  it("detects conditional branch identifiers without regex backtracking", () => {
    expect(isConditionalBranchIdentifier("isEnabled")).toBe(true);
    expect(isConditionalBranchIdentifier("hasFA2Enabled")).toBe(true);
    expect(isConditionalBranchIdentifier("abc123A")).toBe(false);
    expect(isConditionalBranchIdentifier("already_lowercase")).toBe(false);
    expect(isConditionalBranchIdentifier(`a${"A".repeat(4_096)}!`)).toBe(false);
  });

  it("preserves the typed expiry key from Swift extraction through macOS catalog projection", () => {
    const entries = assignNativeI18nIds(
      extractNativeI18nCandidates(
        "apple",
        "apps/macos/Sources/OpenClaw/Expiry.swift",
        [
          "let minutes: Int = 3",
          'Label(String(format: String(localized: "Expires in %lld minutes"), minutes), systemImage: "clock")',
          'Text(verbatim: "\\(name) — \\(minutes)")',
        ].join("\n"),
      ),
    );
    const { catalog } = buildMacosCatalog({}, { version: 2, entries }, []);
    expect(Object.keys(catalog.strings ?? {})).toEqual(["Expires in %lld minutes"]);
    expect(catalog.strings?.["Expires in %lld minutes"]?.localizations?.en?.stringUnit?.value).toBe(
      "Expires in %lld minutes",
    );
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
          Text(if (enabled) "Kotlin enabled " + "now" else "Kotlin disabled " + "now")
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
        "Kotlin enabled now",
        "Kotlin disabled now",
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
          "Kotlin enabled ",
          "Kotlin disabled ",
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

  it("collects stable Android and Apple UI entries", async () => {
    const entries = await collectNativeI18nEntries();
    const surfaces = new Set(entries.map((entry) => entry.surface));

    expect(entries.length).toBeGreaterThan(100);
    expect(surfaces).toEqual(new Set(["android", "apple"]));
    expect(entries.every((entry) => entry.id.startsWith(`native.${entry.surface}.`))).toBe(true);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(
      entries.every((entry) =>
        entry.sites.every(
          (site) => !/(?:\/|\\)(?:Tests?|UITests?|test|Preview(?:s)?)(?:\/|\\)/u.test(site.path),
        ),
      ),
    ).toBe(true);
    expect(
      entries.every((entry) =>
        entry.sites.every(
          (site) => !/(?:Tests?|UITests?|Previews?|Testing)\.(?:swift|kt|kts)$/u.test(site.path),
        ),
      ),
    ).toBe(true);
    expect(
      entries.every((entry) =>
        entry.sites.every((site) => !site.path.endsWith("/NativeStringResources.kt")),
      ),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.surface === "apple")
        .every((entry) =>
          entry.sites.every((site) =>
            /^(?:apps\/ios|apps\/macos\/Sources|apps\/shared\/OpenClawKit\/Sources)\//u.test(
              site.path,
            ),
          ),
        ),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.surface === "android")
        .every((entry) =>
          entry.sites.every(
            (site) =>
              site.path.startsWith("apps/android/app/src/main/") ||
              site.path.startsWith("apps/android/app/src/play/") ||
              site.path.startsWith("apps/android/app/src/thirdParty/") ||
              site.path === "apps/android/wear/src/main/res/values/strings.xml",
          ),
        ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) => site.path === "apps/android/wear/src/main/res/values/strings.xml",
          ) && entry.source === "Current session",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) =>
            site.path.endsWith(
              "/thirdParty/java/ai/openclaw/app/ui/SensitivePhoneCapabilitiesSettings.kt",
            ),
          ) && entry.source === "Control other apps",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) =>
            site.path.endsWith("/accessibility/AccessibilityDevActivity.kt"),
          ) && entry.source === "Accessibility executor",
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
          hasSite(entry, (site) => site.path.endsWith("/ChatMessageActions.kt")) &&
          entry.source === "Message actions",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) => site.path.endsWith("/ChatMessageActions.kt")) &&
          entry.source === "Reply",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) => site.path.endsWith("/ChatMessageActions.kt")) &&
          entry.source === "Share message",
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
          hasSite(
            entry,
            (site) => site.path === "apps/ios/Sources/Design/TalkRuntimeIssueBanner.swift",
          ) && entry.source === "Details",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) => site.path === "apps/ios/Sources/Design/TalkRuntimeIssueBanner.swift",
          ) && entry.source === "Open Settings",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "No threads yet")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) => site.path.endsWith("/ChatSheets.swift")) &&
          entry.source === "Search threads",
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
    expect(entries.some((entry) => entry.source === "Missing binaries: %@")).toBe(true);
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
          hasSite(
            entry,
            (site) =>
              site.path === "apps/ios/Sources/Gateway/GatewayConnectionController.swift" &&
              site.kind === "ui-localized-call-multiline",
          ) &&
          entry.source ===
            "Enable Gateway TLS, or enter your Tailscale Serve HTTPS host in Manual Setup. Use Unencrypted only with a trusted private-LAN address.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) =>
              site.path === "apps/ios/Sources/Gateway/GatewayConnectionController.swift" &&
              site.kind === "ui-localized-call-multiline",
          ) &&
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
    expect(entries.some((entry) => entry.source === "State:  %@")).toBe(true);
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
    expect(
      entries.some((entry) => hasSite(entry, (site) => site.path.endsWith("Info.plist"))),
    ).toBe(true);
    expect(NATIVE_I18N_LOCALES).toHaveLength(21);
    expect(NATIVE_I18N_LOCALES).toContain("sv");
  });

  it("migrates v1 translations deterministically and drops stale IDs after a source edit", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-");
    const entries = assignNativeI18nIds([
      {
        kind: "ui-call",
        line: 1,
        path: "apps/android/Open.kt",
        source: "Open",
        surface: "android",
      },
      {
        kind: "ui-call",
        line: 2,
        path: "apps/ios/Open.swift",
        source: "Open",
        surface: "apple",
      },
      {
        kind: "ui-call",
        line: 3,
        path: "apps/ios/New.swift",
        source: "New string",
        surface: "apple",
      },
    ]);
    const androidOpen = expectDefined(
      entries.find((entry) => entry.surface === "android"),
      "Android Open entry",
    );
    const appleOpen = expectDefined(
      entries.find((entry) => entry.surface === "apple" && entry.source === "Open"),
      "Apple Open entry",
    );
    const newString = expectDefined(
      entries.find((entry) => entry.source === "New string"),
      "new source-fallback entry",
    );

    try {
      const artifactPath = path.join(translationsDir, "sv.json");
      await writeFile(
        artifactPath,
        `${JSON.stringify(
          {
            version: 1,
            locale: "sv",
            glossaryHash: "legacy",
            entries: [
              { id: "native.android.open-a", source: "Open", translated: "Öppna" },
              { id: "native.android.open-b", source: "Open", translated: "Öppna" },
              { id: "native.android.open-c", source: "Open", translated: "Öppen" },
              { id: "native.android.open-d", source: "Open", translated: "Open" },
              { id: "native.apple.open-a", source: "Open", translated: "Beta" },
              { id: "native.apple.open-b", source: "Open", translated: "Alfa" },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const migrated = await syncNativeLocale("sv", entries, {
        glossary: [],
        translationsDir,
        translate: async () => {
          throw new Error("v1 migration must not call the translation provider");
        },
      });
      expect(migrated).toEqual({ carried: 2, changed: true, fallback: 1, translated: 0 });

      const artifact = JSON.parse(
        await readFile(artifactPath, "utf8"),
      ) as NativeTranslationArtifact;
      expect(artifact).toMatchObject({ locale: "sv", version: 2 });
      expect(artifact.translations).toEqual({
        [androidOpen.id]: "Öppna",
        [appleOpen.id]: "Alfa",
        [newString.id]: "New string",
      });

      const firstContents = await readFile(artifactPath, "utf8");
      const firstModifiedAt = (await stat(artifactPath)).mtimeMs;
      await expect(
        syncNativeLocale("sv", entries, {
          glossary: [],
          translationsDir,
          translate: async () => {
            throw new Error("no-op refresh must not call the provider");
          },
        }),
      ).resolves.toEqual({ carried: 3, changed: false, fallback: 1, translated: 0 });
      expect(await readFile(artifactPath, "utf8")).toBe(firstContents);
      expect((await stat(artifactPath)).mtimeMs).toBe(firstModifiedAt);

      const editedAndroid = expectDefined(
        assignNativeI18nIds([
          {
            kind: "ui-call",
            line: 10,
            path: "apps/android/Moved.kt",
            source: "Open now",
            surface: "android",
          },
        ])[0],
        "edited Android source entry",
      );
      await syncNativeLocale("sv", [editedAndroid, appleOpen, newString], {
        glossary: [],
        translationsDir,
        translate: async (pending) => new Map(pending.map((entry) => [entry.id, entry.source])),
      });
      const editedArtifact = JSON.parse(
        await readFile(artifactPath, "utf8"),
      ) as NativeTranslationArtifact;
      expect(editedArtifact.translations[androidOpen.id]).toBeUndefined();
      expect(editedArtifact.translations[editedAndroid.id]).toBe("Open now");
      expect(editedArtifact.translations[appleOpen.id]).toBe("Alfa");
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });
  it("rejects invalid native placeholders inside the translation batch", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-");
    const entry = testEntry("native.apple.progress", "apple", "Processed %lld of %@");
    let translatorReturned = false;

    try {
      await expect(
        syncNativeLocale("sv", [entry], {
          glossary: [],
          translationsDir,
          translate: async (_pending, locale, _glossary, validateTranslation) => {
            const translated = "Bearbetade %@";
            validateTranslation?.(entry.source, translated, entry.id, locale);
            translatorReturned = true;
            return new Map([[entry.id, translated]]);
          },
        }),
      ).rejects.toThrow(
        `native translation changed placeholders or line breaks for sv:${entry.id}`,
      );
      expect(translatorReturned).toBe(false);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("retranslates existing native strings only when a full refresh is requested", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-");
    const entry = testEntry("native.apple.open", "apple", "Open");
    try {
      await syncNativeLocale("sv", [entry], {
        glossary: [],
        translationsDir,
        translate: async () => new Map([[entry.id, "Tidigare"]]),
      });
      const refreshed = await syncNativeLocale("sv", [entry], {
        force: true,
        glossary: [],
        translationsDir,
        translate: async (pending) => new Map(pending.map((item) => [item.id, "Öppna"])),
      });
      expect(refreshed.translated).toBe(1);
      expect(
        JSON.parse(await readFile(path.join(translationsDir, "sv.json"), "utf8")).translations,
      ).toEqual({ [entry.id]: "Öppna" });
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("rejects native printf placeholder drift", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-");
    const cases = [
      {
        entry: testEntry(
          "native.android.certificate",
          "android",
          "Old fingerprint: %1$s\nNew fingerprint: %2$s",
        ),
        translated: "Gammalt fingeravtryck: %1$s",
      },
      {
        entry: testEntry("native.apple.failure", "apple", "Send failed: %@"),
        translated: "Sändningen misslyckades",
      },
      {
        entry: testEntry("native.apple.percent", "apple", "Context %@%% used"),
        translated: "Kontext %@ används",
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

  it("rejects invalid v2 locale artifact structure and translations", () => {
    const inventory = [
      testEntry(
        "native.android.greeting",
        "android",
        "Hello ${name}\nNext",
        "apps/android/Greeting.kt",
      ),
      testEntry("native.apple.other", "apple", "Other", "apps/ios/Other.swift"),
    ];
    const greeting = expectDefined(inventory[0], "native greeting inventory entry");
    const other = expectDefined(inventory[1], "native other inventory entry");
    const emptyGlossaryHash = createHash("sha256").update(JSON.stringify([])).digest("hex");
    const createArtifact = (): NativeTranslationArtifact => ({
      version: 2,
      locale: "sv",
      glossaryHash: emptyGlossaryHash,
      translations: {
        [greeting.id]: "Hej ${name}\nNästa",
        [other.id]: "Annat",
      },
    });
    const cases: Array<{
      expected: string;
      mutate: (artifact: NativeTranslationArtifact) => unknown;
    }> = [
      {
        expected: "version must be 2",
        mutate: (artifact) => ({ ...artifact, version: 1 }),
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
        expected: "translations must be a plain object",
        mutate: (artifact) => ({ ...artifact, translations: [] }),
      },
      {
        expected: `missing translation for ${other.id}`,
        mutate: (artifact) => {
          const { [other.id]: _, ...translations } = artifact.translations;
          return { ...artifact, translations };
        },
      },
      {
        expected: 'unknown translation id "native.apple.unknown"',
        mutate: (artifact) => ({
          ...artifact,
          translations: { ...artifact.translations, "native.apple.unknown": "Okänd" },
        }),
      },
      {
        expected: `translation must be nonempty for ${other.id}`,
        mutate: (artifact) => ({
          ...artifact,
          translations: { ...artifact.translations, [other.id]: "  " },
        }),
      },
      {
        expected: `native translation changed placeholders or line breaks for sv:${greeting.id}`,
        mutate: (artifact) => ({
          ...artifact,
          translations: { ...artifact.translations, [greeting.id]: "Hej\nNästa" },
        }),
      },
      {
        expected: `native translation changed placeholders or line breaks for sv:${greeting.id}`,
        mutate: (artifact) => ({
          ...artifact,
          translations: { ...artifact.translations, [greeting.id]: "Hej ${name} Nästa" },
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
      testEntry(
        "native.android.language-picker",
        "android",
        "OpenClaw translations · $languageTag",
        "apps/android/app/src/main/java/ai/openclaw/app/AppLanguage.kt",
        "conditional-branch",
      ),
      testEntry("native.android.inspect", "android", "Inspect", "apps/android/Workshop.kt"),
      testEntry("native.apple.inspect", "apple", "Inspect", "apps/ios/Workshop.swift"),
      testEntry(
        "native.android.voice-note",
        "android",
        "Record voice note",
        "apps/android/Voice.kt",
      ),
    ];
    const languagePicker = expectDefined(inventory[0], "native language picker inventory entry");
    const androidInspect = expectDefined(inventory[1], "native Android inspect inventory entry");
    const appleInspect = expectDefined(inventory[2], "native Apple inspect inventory entry");
    const voiceNote = expectDefined(inventory[3], "native voice note inventory entry");
    const artifact: NativeTranslationArtifact = {
      version: 2,
      locale: "id",
      glossaryHash: createHash("sha256").update(JSON.stringify([])).digest("hex"),
      translations: {
        [languagePicker.id]: languagePicker.source,
        [androidInspect.id]: androidInspect.source,
        [appleInspect.id]: "Periksa",
        [voiceNote.id]: "Ghi ghi chú thoại",
      },
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
    expect(parseNativeI18nCommand(["sync", "--write", "--locale", "sv", "--force"]).force).toBe(
      true,
    );
    expect(() => parseNativeI18nCommand(["sync", "--write", "--force"])).toThrow(
      "requires `sync --write --locale",
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
