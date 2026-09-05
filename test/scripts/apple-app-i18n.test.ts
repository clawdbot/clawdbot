import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertMacosCatalogCurrent,
  buildIosCatalog,
  buildMacosCatalog,
  compileMacosLocalizations,
  findAmbiguousRuntimeInterpolations,
  infoPlistTranslationCandidates,
  selectInfoPlistTranslation,
  serializeAppleCatalog,
  verifyAppleAppI18n,
} from "../../scripts/apple-app-i18n.ts";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-i18n-locales.ts";

const probe = vi.hoisted(() => ({
  source: "",
  paths: [
    "apps/macos/Sources/OpenClaw/OnboardingAISetupView.swift",
    "apps/ios/Sources/Gateway/ExecApprovalPromptDialog.swift",
    "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatComposer+Controls.swift",
    "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayDiscoveryStatusText.swift",
  ],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Synthetic calls are opt-in and limited to production-source reads; all other I/O stays real.
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const source = await actual.readFile(...args);
      const file = typeof args[0] === "string" ? args[0].replaceAll("\\", "/") : "";
      return probe.source &&
        typeof source === "string" &&
        probe.paths.some((entry) => file.endsWith("/" + entry))
        ? source + "\n" + probe.source
        : source;
    },
  };
});

describe("Apple app i18n catalogs", () => {
  it("verification and compile-macos reject raw macOS interpolation and retain shared/iOS coverage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-apple-runtime-"));
    const output = path.join(root, "output");
    const gates = [() => verifyAppleAppI18n(), () => compileMacosLocalizations(output)];
    try {
      probe.source = 'Label("Expires in \\(minutes) minutes", systemImage: "clock")';
      const diagnostic = [
        "Apple i18n runtime interpolation bypasses generated catalog coverage:",
        ...probe.paths
          .toSorted()
          .map((entry) => path.normalize(entry) + ": interpolated SwiftUI text literal"),
      ].join("\n");
      for (const gate of gates) {
        await expect(gate()).rejects.toThrow(new Error(diagnostic));
      }
      await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });

      probe.source = [
        "let minutes: Int = 3",
        'Label(String(format: String(localized: "Expires in %lld minutes"), minutes), systemImage: "clock")',
        'Text(verbatim: "\\(name) — \\(minutes)")',
        "let count: Int = 2",
        'String(AttributedString(localized: "^[\\(count) message](inflect: true)").characters)',
      ].join("\n");
      for (const gate of gates) {
        await expect(gate()).resolves.toBeUndefined();
      }
    } finally {
      probe.source = "";
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps source-owned runtime coverage complete", async () => {
    await expect(verifyAppleAppI18n()).resolves.toBeUndefined();
  });

  it("ships translated runtime keys for iOS, watchOS, and explicit localized calls", async () => {
    const catalog = JSON.parse(
      await readFile("apps/ios/Resources/Localizable.xcstrings", "utf8"),
    ) as {
      strings: Record<
        string,
        { localizations?: Record<string, { stringUnit?: { state?: string; value?: string } }> }
      >;
    };

    for (const key of [
      "^[%lld approval](inflect: true) waiting",
      "Approval needed",
      "Agent: %@",
      "Connect a nearby Gateway",
      "Direct mode supports device info, status, and notifications. Chat, Talk, and approvals still use the iPhone.",
      "Expires in %@",
      "Location Services are off in iOS Settings.",
      "Message Routing",
      "No cards in %@",
      "No proposals in %@",
      "Pending review",
      "Secure connection is required for this host.",
      "TLS required",
      "Use only on a trusted private network.",
    ]) {
      const entry = catalog.strings[key];
      expect(entry, key).toBeDefined();
      const localizedValues: string[] = [];
      for (const locale of ["en", ...NATIVE_I18N_LOCALES]) {
        const unit = entry?.localizations?.[locale]?.stringUnit;
        expect(unit?.value, `${key}:${locale}`).toBeTruthy();
        if (locale !== "en" && unit?.value) {
          localizedValues.push(unit.value);
        }
      }
      expect(
        localizedValues.some((value) => value !== key),
        key,
      ).toBe(true);
    }
  });

  it("derives shared discovery status coverage into the iOS catalog", async () => {
    const inventory = JSON.parse(await readFile("apps/.i18n/native-source.json", "utf8")) as {
      entries: Array<{
        id: string;
        source: string;
        sites: Array<{ kind: string; path: string }>;
        surface: string;
      }>;
      version: number;
    };
    const build = buildIosCatalog(
      { sourceLanguage: "en", strings: {}, version: "1.0" },
      inventory,
      [],
    );

    expect(Object.keys(build.catalog.strings ?? {})).toEqual(
      expect.arrayContaining(["Searching…", "Stopped", "Waiting"]),
    );
  });

  it("derives broad macOS catalog coverage from the native source inventory", async () => {
    const inventory = JSON.parse(await readFile("apps/.i18n/native-source.json", "utf8")) as {
      entries: Array<{
        id: string;
        source: string;
        sites: Array<{ kind: string; path: string }>;
        surface: string;
      }>;
      version: number;
    };
    const build = buildMacosCatalog(
      { sourceLanguage: "en", strings: {}, version: "1.0" },
      inventory,
      [],
    );
    const keys = Object.keys(build.catalog.strings ?? {});

    expect(keys.length).toBeGreaterThan(900);
    expect(keys).toEqual(
      expect.arrayContaining([
        "Browse ClawHub",
        "Done in %@",
        "Enable debug tools",
        "Everyday OpenClaw app behavior.",
        "General",
        "Searching…",
        "Shelling",
        "Stopped",
        "Voice Wake requires macOS 26 or newer",
        "Waiting",
      ]),
    );
    expect(keys).not.toContain("OpenClaw");
    expect(keys.some((key) => key.includes("\\("))).toBe(false);
  });

  it("rejects a checked-in macOS catalog that lags the derived inventory", () => {
    const build = buildMacosCatalog(
      { sourceLanguage: "en", strings: {}, version: "1.0" },
      {
        version: 2,
        entries: [
          {
            id: "native.apple.settings",
            source: "Settings",
            sites: [{ kind: "ui-call", path: "apps/macos/Sources/OpenClaw/Settings.swift" }],
            surface: "apple",
          },
        ],
      },
      [],
    );

    expect(() =>
      assertMacosCatalogCurrent(
        `${JSON.stringify({ sourceLanguage: "en", strings: {}, version: "1.0" }, null, 2)}\n`,
        build,
      ),
    ).toThrow("Apple catalog apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings is stale");
  });

  it("serializes one complete localization key per line without losing nested metadata", () => {
    const catalog = {
      sourceLanguage: "en",
      strings: {
        Plain: {
          localizations: {
            en: { stringUnit: { state: "translated", value: "Plain" } },
          },
        },
        "Rich %@": {
          comment: "Translator context",
          extractionState: "manual",
          shouldTranslate: false,
          localizations: {
            en: {
              substitutions: {
                count: {
                  variations: {
                    plural: {
                      one: { stringUnit: { state: "translated", value: "One %@" } },
                      other: { stringUnit: { state: "new", value: "%@ items" } },
                    },
                  },
                },
              },
              stringUnit: { state: "translated", value: "Rich %@" },
            },
          },
        },
      },
      version: "1.0",
    };

    const serialized = serializeAppleCatalog(catalog);
    const lines = serialized.trimEnd().split("\n");

    expect(JSON.parse(serialized)).toEqual(catalog);
    expect(lines).toHaveLength(Object.keys(catalog.strings).length + 6);
    expect(lines[3]).toBe(`    "Plain": ${JSON.stringify(catalog.strings.Plain)},`);
    expect(lines[4]).toBe(`    "Rich %@": ${JSON.stringify(catalog.strings["Rich %@"])}`);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("keeps macOS settings literals localized and runtime values verbatim", async () => {
    const [components, channels, clawHub, gateways, general, approvals, voiceWake] =
      await Promise.all([
        readFile("apps/macos/Sources/OpenClaw/SettingsComponents.swift", "utf8"),
        readFile("apps/macos/Sources/OpenClaw/ChannelConfigForm.swift", "utf8"),
        readFile("apps/macos/Sources/OpenClaw/ClawHubSkillsBrowser.swift", "utf8"),
        readFile("apps/macos/Sources/OpenClaw/GatewaySettings.swift", "utf8"),
        readFile("apps/macos/Sources/OpenClaw/GeneralSettings.swift", "utf8"),
        readFile("apps/macos/Sources/OpenClaw/SystemRunSettingsView.swift", "utf8"),
        readFile("apps/macos/Sources/OpenClaw/VoiceWakeSettings.swift", "utf8"),
      ]);

    expect(components).toContain("enum SettingsTextValue: ExpressibleByStringLiteral");
    expect(components).toContain("case localized(LocalizedStringKey)");
    expect(components).toContain("case verbatim(String)");
    expect(components).toContain("let title: SettingsTextValue");
    expect(components).not.toContain("let title: String");
    expect(channels).toContain('title: label.map(SettingsTextValue.verbatim) ?? "Enabled"');
    expect(channels).toContain("subtitle: help.map(SettingsTextValue.verbatim)");
    expect(clawHub).toContain("title: .verbatim(self.skill.displayName)");
    expect(gateways).toContain("subtitle: .verbatim(profile.url.absoluteString)");
    expect(general).toContain(
      "subtitle: self.controlChannelSubtitle.map(SettingsTextValue.verbatim)",
    );
    expect(approvals).toContain(
      "subtitle: self.model.readErrorMessage.map(SettingsTextValue.verbatim)",
    );
    expect(approvals).toContain("subtitle: .localized(self.model.security.policyDescription)");
    expect(approvals).toContain("subtitle: .localized(self.model.ask.policyDescription)");
    expect(voiceWake).toContain('format: String(localized: "Language %lld")');
  });

  it("routes merged sites by coupled path and kind while preserving shipped translations", () => {
    const coveredMacosEntries = [
      { kind: "ui-call-concatenated", source: "Call concatenated" },
      {
        kind: "ui-localized-call-concatenated",
        source:
          "Older generated approvals are inactive because they were not tied to a working directory. Manual rules are unchanged.",
      },
      { kind: "ui-modifier-concatenated", source: "Modifier concatenated" },
      { kind: "ui-modifier-multiline", source: "Modifier multiline" },
      { kind: "ui-named-argument-concatenated", source: "Named argument concatenated" },
    ].map(({ kind, source }, index) => ({
      id: `native.apple.concatenated.${index}`,
      source,
      surface: "apple",
      sites: [{ kind, path: "apps/macos/Sources/OpenClaw/Example.swift" }],
    }));
    const inventory = {
      version: 2,
      entries: [
        {
          id: "native.apple.connect",
          source: "Connect now",
          surface: "apple",
          sites: [
            { kind: "ui-call", path: "apps/ios/Sources/Example.swift" },
            { kind: "ui-call", path: "apps/macos/Sources/OpenClaw/Example.swift" },
          ],
        },
        {
          id: "native.apple.decoy",
          source: "Do not catalog",
          surface: "apple",
          sites: [
            { kind: "plist-string", path: "apps/ios/Sources/Info.plist" },
            { kind: "ui-call", path: "outside/Example.swift" },
          ],
        },
        ...coveredMacosEntries,
      ],
    };
    const existing = {
      sourceLanguage: "en",
      strings: {
        "Connect now": {
          localizations: {
            de: { stringUnit: { state: "translated", value: "Jetzt verbinden" } },
          },
        },
      },
    };
    const translations = [
      {
        version: 2,
        locale: "fr",
        translations: { "native.apple.connect": "Se connecter" },
      },
    ];
    const ios = buildIosCatalog(existing, inventory, translations);
    const macos = buildMacosCatalog({ sourceLanguage: "en", strings: {} }, inventory, translations);

    expect(ios.catalog.strings?.["Connect now"]?.localizations?.de?.stringUnit?.value).toBe(
      "Jetzt verbinden",
    );
    expect(ios.catalog.strings?.["Connect now"]?.localizations?.fr?.stringUnit).toEqual({
      state: "translated",
      value: "Se connecter",
    });
    expect(ios.catalog.strings?.["Connect now"]?.localizations?.es?.stringUnit).toEqual({
      state: "new",
      value: "Connect now",
    });
    expect(ios.catalog.strings?.["Do not catalog"]).toBeUndefined();
    expect(macos.catalog.strings?.["Connect now"]).toBeDefined();
    expect(Object.keys(macos.catalog.strings ?? {})).toEqual(
      expect.arrayContaining(coveredMacosEntries.map((entry) => entry.source)),
    );
    expect(macos.catalog.strings?.["Do not catalog"]).toBeUndefined();
    expect(ios.contradictions).toEqual([]);
  });

  it.each([
    ["iOS", buildIosCatalog, "apps/ios/Sources/Example.swift"],
    ["macOS", buildMacosCatalog, "apps/macos/Sources/OpenClaw/Example.swift"],
    ["shared iOS", buildIosCatalog, "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Example.swift"],
    [
      "shared macOS",
      buildMacosCatalog,
      "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Example.swift",
    ],
  ] as const)(
    "converts only constrained inflected counts into typed %s catalog keys",
    (_platform, buildCatalog, sourcePath) => {
      const source = "^[\\(count) entry](inflect: true)";
      const translated = "^[\\(count) Eintrag](inflect: true)";
      const build = buildCatalog(
        { sourceLanguage: "en", strings: {} },
        {
          version: 2,
          entries: [
            {
              id: "native.apple.count",
              source,
              sites: [{ kind: "ui-localized-call", path: sourcePath }],
              surface: "apple",
            },
            {
              id: "native.apple.mixed-count",
              source: "\\(name) has " + source,
              sites: [{ kind: "ui-localized-call", path: sourcePath }],
              surface: "apple",
            },
          ],
        },
        [
          {
            version: 2,
            locale: "de",
            translations: { "native.apple.count": translated },
          },
        ],
      );

      const key = "^[%lld entry](inflect: true)";
      expect(Object.keys(build.catalog.strings ?? {})).toEqual([key]);
      expect(build.catalog.strings?.[key]?.localizations?.en?.stringUnit?.value).toBe(key);
      expect(build.catalog.strings?.[key]?.localizations?.de?.stringUnit?.value).toBe(
        "^[%lld Eintrag](inflect: true)",
      );
    },
  );

  it("keeps custom component text on explicit localized or verbatim paths", async () => {
    const design = await readFile("apps/ios/Sources/Design/OpenClawProComponents.swift", "utf8");
    const agentDetailComponents = await readFile(
      "apps/ios/Sources/Design/AgentProDetailComponents.swift",
      "utf8",
    );
    const agentDreaming = await readFile(
      "apps/ios/Sources/Design/AgentProDreamingDestination.swift",
      "utf8",
    );
    const settingsActions = await readFile(
      "apps/ios/Sources/Design/SettingsProTabActions.swift",
      "utf8",
    );
    const settingsSections = await readFile(
      "apps/ios/Sources/Design/SettingsProTabSections.swift",
      "utf8",
    );
    const gatewayCapabilities = await readFile(
      "apps/ios/Sources/Gateway/GatewayConnectionController+Capabilities.swift",
      "utf8",
    );
    const talkMode = await readFile("apps/ios/Sources/Voice/TalkModeManager.swift", "utf8");
    const voiceWake = await readFile("apps/ios/Sources/Voice/VoiceWakeManager.swift", "utf8");
    const settings = await readFile("apps/ios/Sources/Design/SettingsProTabSupport.swift", "utf8");
    const watch = await readFile("apps/ios/WatchApp/Sources/WatchInboxView.swift", "utf8");
    const watchDirect = await readFile("apps/ios/WatchApp/Sources/WatchDirectNode.swift", "utf8");

    expect(design).toContain(
      "struct ProStatusRow: View {\n    let icon: String\n    let title: OpenClawTextValue\n    let detail: OpenClawTextValue",
    );
    expect(design).not.toContain(
      "struct ProStatusRow: View {\n    let icon: String\n    let title: String",
    );
    expect(watch).toContain(
      "private struct WatchHeroCard: View {\n    let label: WatchTextValue\n    let title: WatchTextValue\n    let subtitle: WatchTextValue",
    );
    expect(watch).toContain("case localized(LocalizedStringResource)");
    expect(watch).not.toContain("WatchTextValue: ExpressibleByStringLiteral");
    expect(watch).toContain("accessory: .verbatim(self.store.talkSummaryText)");
    expect(watch).toContain("title: .verbatim(record.approval.commandPreview");
    expect(settings).toContain(
      "let title: OpenClawTextValue\n    let detail: OpenClawTextValue\n    let priority: OpenClawTextValue",
    );
    expect(settings).toContain(
      "struct SettingsDetailRow: View {\n    let label: LocalizedStringKey\n    let value: OpenClawTextValue",
    );
    expect(settings).toContain("self.value.text");
    expect(settings).not.toContain("Text(self.item.title)");
    expect(agentDetailComponents).toContain(
      "func agentProDetailMetric(label: OpenClawTextValue, value: String)",
    );
    expect(agentDetailComponents).toContain("Text(verbatim: value)");
    expect(agentDetailComponents).toContain(
      "func agentProEmptyDetailRow(\n    icon: String,\n    title: OpenClawTextValue,\n    detail: OpenClawTextValue)",
    );
    expect(agentDetailComponents).toContain("title.text");
    expect(agentDetailComponents).toContain("detail.text");
    expect(agentDetailComponents).not.toContain("func agentProDetailMetric(label: String");
    expect(agentDetailComponents).not.toContain(
      "func agentProEmptyDetailRow(icon: String, title: String",
    );
    expect(agentDreaming).toContain("agentProDetailMetric(");
    expect(agentDreaming).toContain("agentProEmptyDetailRow(");
    expect(agentDreaming).not.toContain("private func detailMetric(label: String");
    expect(agentDreaming).not.toContain("private func detailMetric(");
    expect(agentDreaming).not.toContain("private func emptyDetailRow(");
    expect(settingsActions).toContain(
      "func diagnosticCheckRow(\n        icon: String,\n        title: OpenClawTextValue,\n        detail: OpenClawTextValue,\n        value: OpenClawTextValue",
    );
    expect(settingsSections).toContain("func settingsToggle(\n        _ title: LocalizedStringKey");
    expect(settingsSections).toContain(
      "func gatewaySecureField(\n        _ placeholder: LocalizedStringKey",
    );
    expect(gatewayCapabilities).toContain(
      'String(localized: "Secure connection is required for this host.")',
    );
    expect(talkMode).not.toContain('self.statusText = "');
    expect(voiceWake).not.toContain('self.statusText = "');
    expect(watch).toContain('format: String(localized: "Expires in %@")');
    expect(watch).not.toContain('parts.append("Expires in \\(expiresText)")');
    expect(watchDirect).not.toContain('self.statusText = "');
  });

  it("rejects interpolated runtime copy across every supported Swift syntax", () => {
    const source = String.raw`
      let key = LocalizedStringKey("Hello \(name)")
      let detail = String(localized: """
        Welcome \(name)
        """)
      Toggle("Enable \(feature)", isOn: $enabled)
      Menu("""
        Open \(item)
        """) {}
      view.accessibilityHint("""
        Select \(item)
        """)
    `;

    expect(findAmbiguousRuntimeInterpolations(source)).toEqual([
      "interpolated localized resource",
      "interpolated multiline localized resource",
      "interpolated SwiftUI text literal",
      "interpolated multiline SwiftUI text literal",
      "interpolated multiline SwiftUI modifier literal",
    ]);
  });

  it("generates only localized usage descriptions for every shipped iOS target", async () => {
    const french = await readFile("apps/ios/Sources/fr.lproj/InfoPlist.strings", "utf8");
    const watchChinese = await readFile(
      "apps/ios/WatchApp/zh-Hans.lproj/InfoPlist.strings",
      "utf8",
    );
    const shareGerman = await readFile(
      "apps/ios/ShareExtension/de.lproj/InfoPlist.strings",
      "utf8",
    );
    const activityJapanese = await readFile(
      "apps/ios/ActivityWidget/ja.lproj/InfoPlist.strings",
      "utf8",
    );

    expect(french).toContain('"NSCameraUsageDescription" = ');
    expect(french).toContain('"NSMicrophoneUsageDescription" = ');
    expect(french).toContain('"NSHealthUpdateUsageDescription" = ');
    expect(watchChinese).toContain('"NSLocalNetworkUsageDescription" = ');
    expect(shareGerman.trim()).toBe("");
    expect(activityJapanese.trim()).toBe("");

    for (const root of [
      "apps/ios/Sources",
      "apps/ios/WatchApp",
      "apps/ios/ShareExtension",
      "apps/ios/ActivityWidget",
    ]) {
      const localeDirs = (await readdir(root, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && entry.name.endsWith(".lproj"),
      );
      expect(localeDirs).toHaveLength(NATIVE_I18N_LOCALES.length);
      for (const localeDir of localeDirs) {
        const localizedPlist = await readFile(
          path.join(root, localeDir.name, "InfoPlist.strings"),
          "utf8",
        );
        expect(localizedPlist).not.toContain("CFBundleDisplayName");
        expect(localizedPlist).not.toMatch(/\$\([^)]*\)|\$\{[^}]*\}/u);
      }
    }
  });

  it("refreshes InfoPlist copy from translations for the current source", () => {
    expect(
      selectInfoPlistTranslation(
        "Use the camera to scan setup codes.",
        ["Utilisez l’appareil photo pour scanner les codes de configuration."],
        {
          source: "Old camera purpose.",
          value: "Ancienne description de la caméra.",
        },
      ),
    ).toBe("Utilisez l’appareil photo pour scanner les codes de configuration.");
    expect(
      selectInfoPlistTranslation("OpenClaw Share", [], {
        source: "OpenClaw Share",
        value: "OpenClaw Partager",
      }),
    ).toBe("OpenClaw Partager");
    expect(
      selectInfoPlistTranslation(
        "Use the camera to scan setup codes.",
        ["Use the camera to scan setup codes."],
        {
          source: "Use the camera to scan setup codes.",
          value: "Utilisez l’appareil photo pour scanner les codes de configuration.",
        },
      ),
    ).toBe("Utilisez l’appareil photo pour scanner les codes de configuration.");
    expect(
      selectInfoPlistTranslation("Use the camera for video calls.", [], {
        source: "Use the camera to scan setup codes.",
        value: "Utilisez l’appareil photo pour scanner les codes de configuration.",
      }),
    ).toBe("Use the camera for video calls.");
  });

  it("selects InfoPlist candidates by stable ID instead of shared source text", () => {
    const source = "Use the camera to scan setup codes.";
    const artifact = {
      version: 2,
      locale: "fr",
      translations: {
        "native.apple.camera": "Utilisez l’appareil photo pour scanner les codes de configuration.",
        "native.apple.unrelated": "Traduction pour un autre contexte.",
      },
    };

    expect(infoPlistTranslationCandidates(artifact, "native.apple.camera", source)).toEqual([
      "Utilisez l’appareil photo pour scanner les codes de configuration.",
    ]);
  });

  it("compiles macOS catalogs into app-bundle localization directories", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-apple-i18n-"));
    try {
      await compileMacosLocalizations(outputDir);
      const english = await readFile(
        path.join(outputDir, "en.lproj", "Localizable.strings"),
        "utf8",
      );
      expect(english).toContain('"Expires in %lld minutes" = "Expires in %lld minutes";');
      expect(english).toContain(
        '"^[%lld message](inflect: true)" = "^[%lld message](inflect: true)";',
      );
      const swedish = await readFile(
        path.join(outputDir, "sv.lproj", "Localizable.strings"),
        "utf8",
      );
      expect(swedish).toContain('"Logout" = "Logga ut";');
      const turkish = await readFile(
        path.join(outputDir, "tr.lproj", "Localizable.strings"),
        "utf8",
      );
      expect(turkish).toContain('"General" = "Genel";');
      const frenchInfoPlist = await readFile(
        path.join(outputDir, "fr.lproj", "InfoPlist.strings"),
        "utf8",
      );
      expect(frenchInfoPlist).toContain(
        '"NSUserNotificationUsageDescription" = "OpenClaw a besoin de l’autorisation d’envoyer des notifications pour afficher des alertes concernant les actions de l’agent.";',
      );
      expect(frenchInfoPlist).toContain('"NSScreenCaptureDescription" = ');
      expect(frenchInfoPlist).toContain('"NSLocationUsageDescription" = ');
      expect(frenchInfoPlist).toContain('"NSLocationWhenInUseUsageDescription" = ');
      expect(frenchInfoPlist).toContain('"NSLocationAlwaysAndWhenInUseUsageDescription" = ');
      await expect(
        readFile(path.join(outputDir, "zh-Hans.lproj", "Localizable.strings"), "utf8"),
      ).resolves.toContain('"Save" = ');
      await expect(
        readFile(path.join(outputDir, "ja.lproj", "Localizable.strings"), "utf8"),
      ).resolves.toContain('"Run now" = ');
      for (const localeDir of ["ja", "zh-Hans", "zh-Hant"]) {
        await expect(
          readFile(path.join(outputDir, `${localeDir}.lproj`, "InfoPlist.strings"), "utf8"),
        ).resolves.toContain('"NSCameraUsageDescription" = ');
      }
      const localizedDirectories = await readdir(outputDir, { withFileTypes: true });
      const infoPlistFiles = await Promise.all(
        localizedDirectories
          .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lproj"))
          .map(async (entry) => {
            try {
              await readFile(path.join(outputDir, entry.name, "InfoPlist.strings"), "utf8");
              return entry.name;
            } catch {
              return null;
            }
          }),
      );
      expect(infoPlistFiles.filter(Boolean)).toHaveLength(NATIVE_I18N_LOCALES.length);
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });
});
