import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPLE_I18N_LOCALES,
  assertMacosCatalogCurrent,
  buildIosCatalog,
  buildMacosCatalog,
  compileMacosLocalizations,
  findAmbiguousRuntimeInterpolations,
  infoPlistTranslationCandidates,
  selectInfoPlistTranslation,
  verifyAppleAppI18n,
} from "../../scripts/apple-app-i18n.ts";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-app-i18n.ts";

describe("Apple app i18n catalogs", () => {
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
      "^[%lld agent](inflect: true) total",
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
      for (const locale of ["en", ...APPLE_I18N_LOCALES]) {
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

  it("keeps the Apple and native shipped locale sets identical", () => {
    expect(APPLE_I18N_LOCALES).toEqual(NATIVE_I18N_LOCALES);
  });

  it("derives broad macOS catalog coverage from the native source inventory", async () => {
    const inventory = JSON.parse(await readFile("apps/.i18n/native-source.json", "utf8")) as {
      entries: Array<{
        id: string;
        kind: string;
        line: number;
        path: string;
        source: string;
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
        "Shelling",
        "Voice Wake requires macOS 26 or newer",
      ]),
    );
    expect(keys).not.toContain("OpenClaw");
    expect(keys.some((key) => key.includes("\\("))).toBe(false);
  });

  it("rejects a checked-in macOS catalog that lags the derived inventory", () => {
    const build = buildMacosCatalog(
      { sourceLanguage: "en", strings: {}, version: "1.0" },
      {
        version: 1,
        entries: [
          {
            id: "native.apple.settings",
            kind: "ui-call",
            line: 1,
            path: "apps/macos/Sources/OpenClaw/Settings.swift",
            source: "Settings",
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

  it("selects duplicate-source translations deterministically while preserving shipped translations", () => {
    const build = buildIosCatalog(
      {
        sourceLanguage: "en",
        strings: {
          "Connect now": {
            localizations: {
              de: { stringUnit: { state: "translated", value: "Jetzt verbinden" } },
            },
          },
        },
      },
      {
        version: 1,
        entries: [
          {
            id: "native.apple.a",
            kind: "ui-call",
            line: 1,
            path: "apps/ios/Sources/Example.swift",
            source: "Connect now",
            surface: "apple",
          },
          {
            id: "native.apple.b",
            kind: "ui-call",
            line: 2,
            path: "apps/ios/Sources/Other.swift",
            source: "Connect now",
            surface: "apple",
          },
          {
            id: "native.apple.c",
            kind: "ui-call",
            line: 3,
            path: "apps/ios/WatchApp/Sources/Example.swift",
            source: "Connect now",
            surface: "apple",
          },
        ],
      },
      [
        {
          version: 1,
          locale: "fr",
          entries: [
            { id: "native.apple.a", source: "Connect now", translated: "Se connecter" },
            { id: "native.apple.b", source: "Connect now", translated: "Connexion" },
            { id: "native.apple.c", source: "Connect now", translated: "Se connecter" },
          ],
        },
      ],
    );

    expect(build.catalog.strings?.["Connect now"]?.localizations?.de?.stringUnit?.value).toBe(
      "Jetzt verbinden",
    );
    expect(build.catalog.version).toBe("1.0");
    expect(build.catalog.strings?.["Connect now"]?.localizations?.fr?.stringUnit?.value).toBe(
      "Se connecter",
    );
    expect(build.catalog.strings?.["Connect now"]?.localizations?.fr?.stringUnit?.state).toBe(
      "translated",
    );
    expect(build.catalog.strings?.["Connect now"]?.localizations?.es?.stringUnit).toEqual({
      state: "new",
      value: "Connect now",
    });
    expect(build.contradictions).toEqual([
      {
        locale: "fr",
        source: "Connect now",
        translations: ["Connexion", "Se connecter"],
      },
    ]);

    const refreshed = buildIosCatalog(
      build.catalog,
      {
        version: 1,
        entries: [
          {
            id: "native.apple.a",
            kind: "ui-call",
            line: 1,
            path: "apps/ios/Sources/Example.swift",
            source: "Connect now",
            surface: "apple",
          },
        ],
      },
      [
        {
          version: 1,
          locale: "de",
          entries: [{ id: "native.apple.a", source: "Connect now", translated: "Neu verbinden" }],
        },
        {
          version: 1,
          locale: "fr",
          entries: [{ id: "native.apple.a", source: "Connect now", translated: "Connectez-vous" }],
        },
      ],
    );
    expect(refreshed.catalog.strings?.["Connect now"]?.localizations?.de?.stringUnit?.value).toBe(
      "Jetzt verbinden",
    );
    expect(refreshed.catalog.strings?.["Connect now"]?.localizations?.fr?.stringUnit).toEqual({
      state: "translated",
      value: "Se connecter",
    });
  });

  it("uses code-unit ordering for canonically equivalent translations", () => {
    const source = "Resume";
    const decomposed = "Re\u0301sume\u0301";
    const composed = "Résumé";
    const build = buildIosCatalog(
      { sourceLanguage: "en", strings: {} },
      {
        version: 1,
        entries: [
          {
            id: "native.apple.resume-a",
            kind: "ui-call",
            line: 1,
            path: "apps/ios/Sources/Example.swift",
            source,
            surface: "apple",
          },
          {
            id: "native.apple.resume-b",
            kind: "ui-call",
            line: 2,
            path: "apps/ios/Sources/Other.swift",
            source,
            surface: "apple",
          },
        ],
      },
      [
        {
          version: 1,
          locale: "fr",
          entries: [
            { id: "native.apple.resume-a", source, translated: composed },
            { id: "native.apple.resume-b", source, translated: decomposed },
          ],
        },
      ],
    );

    expect(build.catalog.strings?.[source]?.localizations?.fr?.stringUnit?.value).toBe(decomposed);
    expect(build.contradictions[0]?.translations).toEqual([decomposed, composed]);
  });

  it("converts inflected Swift count resources into typed catalog placeholders", () => {
    const source = "^[\\(count) entry](inflect: true)";
    const translated = "^[\\(count) Eintrag](inflect: true)";
    const build = buildIosCatalog(
      { sourceLanguage: "en", strings: {} },
      {
        version: 1,
        entries: [
          {
            id: "native.apple.count",
            kind: "ui-localized-call",
            line: 1,
            path: "apps/ios/Sources/Example.swift",
            source,
            surface: "apple",
          },
        ],
      },
      [
        {
          version: 1,
          locale: "de",
          entries: [{ id: "native.apple.count", source, translated }],
        },
      ],
    );

    const key = "^[%lld entry](inflect: true)";
    expect(build.catalog.strings?.[key]?.localizations?.en?.stringUnit?.value).toBe(key);
    expect(build.catalog.strings?.[key]?.localizations?.de?.stringUnit?.value).toBe(
      "^[%lld Eintrag](inflect: true)",
    );
  });

  it("rejects mixed inflected resources whose placeholder types are ambiguous", () => {
    const source = "\\(name) has ^[\\(count) entry](inflect: true)";
    const build = buildIosCatalog(
      { sourceLanguage: "en", strings: {} },
      {
        version: 1,
        entries: [
          {
            id: "native.apple.mixed-count",
            kind: "ui-localized-call",
            line: 1,
            path: "apps/ios/Sources/Example.swift",
            source,
            surface: "apple",
          },
        ],
      },
      [],
    );

    expect(build.catalog.strings).toEqual({});
  });

  it("keeps custom component text on explicit localized or verbatim paths", async () => {
    const design = await readFile("apps/ios/Sources/Design/OpenClawProComponents.swift", "utf8");
    const agentOverview = await readFile(
      "apps/ios/Sources/Design/AgentProTab+Overview.swift",
      "utf8",
    );
    const agentDetailComponents = await readFile(
      "apps/ios/Sources/Design/AgentProTab+DetailComponents.swift",
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
    expect(agentOverview).toContain(
      "func metricTile(\n        icon: String,\n        title: OpenClawTextValue,\n        value: String,\n        detail: OpenClawTextValue",
    );
    expect(agentDetailComponents).toContain(
      "func detailMetric(label: OpenClawTextValue, value: String)",
    );
    expect(agentDetailComponents).toContain("Text(verbatim: value)");
    expect(agentDetailComponents).toContain(
      "func emptyDetailRow(\n        icon: String,\n        title: OpenClawTextValue,\n        detail: OpenClawTextValue)",
    );
    expect(agentDetailComponents).toContain("title.text");
    expect(agentDetailComponents).toContain("detail.text");
    expect(agentDetailComponents).not.toContain("func detailMetric(label: String");
    expect(agentDetailComponents).not.toContain("func emptyDetailRow(icon: String, title: String");
    expect(agentDreaming).toContain(
      "private func detailMetric(label: OpenClawTextValue, value: String)",
    );
    expect(agentDreaming).toContain("label.text");
    expect(agentDreaming).toContain("Text(verbatim: value)");
    expect(agentDreaming).not.toContain("private func detailMetric(label: String");
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
      expect(localeDirs).toHaveLength(APPLE_I18N_LOCALES.length);
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
      version: 1,
      locale: "fr",
      entries: [
        {
          id: "native.apple.camera",
          source,
          translated: "Utilisez l’appareil photo pour scanner les codes de configuration.",
        },
        {
          id: "native.apple.unrelated",
          source,
          translated: "Traduction pour un autre contexte.",
        },
      ],
    };

    expect(infoPlistTranslationCandidates(artifact, "native.apple.camera", source)).toEqual([
      "Utilisez l’appareil photo pour scanner les codes de configuration.",
    ]);
  });

  it("compiles macOS catalogs into app-bundle localization directories", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-apple-i18n-"));
    try {
      await compileMacosLocalizations(outputDir);
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
      await expect(
        readFile(path.join(outputDir, "zh-Hans.lproj", "Localizable.strings"), "utf8"),
      ).resolves.toContain('"Save" = ');
      await expect(
        readFile(path.join(outputDir, "ja.lproj", "Localizable.strings"), "utf8"),
      ).resolves.toContain('"Run now" = ');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });
});
