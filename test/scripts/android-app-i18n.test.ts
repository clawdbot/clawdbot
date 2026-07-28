import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildAndroidAppI18nCatalog,
  checkAndroidAppI18n,
  decodeAndroidResourceValue,
  escapeAndroidResourceValue,
  findUnusedAndroidResourceKeys,
  findUnlocalizedAndroidUiLiterals,
  renderAndroidResourceValue,
  selectDeterministicTranslation,
  selectExactArtifactTranslation,
  selectGeneratedTranslation,
} from "../../scripts/android-app-i18n.ts";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-app-i18n.ts";

describe("Android app i18n resources", () => {
  it("keeps generated resources, runtime coverage, and every locale aligned", async () => {
    // Managed native_* rows are reconciled by the post-merge locale refresh
    // workflow (#111557); source PRs are validated with those rows pending.
    await expect(checkAndroidAppI18n({ tolerateManagedPending: true })).resolves.toBeUndefined();
    const base = await readFile("apps/android/app/src/main/res/values/strings.xml", "utf8");
    const wearBase = await readFile("apps/android/wear/src/main/res/values/strings.xml", "utf8");
    expect(base).toContain('xmlns:tools="http://schemas.android.com/tools"');
    expect(base).toMatch(
      /<string name="native_[a-f0-9]+"[^>]*tools:ignore="Typos,TypographyDashes,TypographyEllipsis">/u,
    );
    expect(wearBase).toContain('<string name="current_session">Current session</string>');
  });

  it("routes compact token suffixes through generated resources", async () => {
    const inventory = JSON.parse(await readFile("apps/.i18n/native-source.json", "utf8")) as {
      entries: Array<{ kind: string; path: string; source: string }>;
    };
    const sources = new Set(["${decimal(count / 1_000_000.0)}M", "${thousands}k"]);
    const entries = inventory.entries
      .filter(
        (entry) => entry.path.endsWith("/ui/chat/ChatTurnRecap.kt") && sources.has(entry.source),
      )
      .map(({ kind, source }) => ({ kind, source }))
      .toSorted((left, right) => left.source.localeCompare(right.source));

    expect(entries).toEqual([
      { kind: "ui-call", source: "${decimal(count / 1_000_000.0)}M" },
      { kind: "ui-call", source: "${thousands}k" },
    ]);
  });

  it("builds complete Wear resources for every native locale", async () => {
    const catalog = await buildAndroidAppI18nCatalog();
    const wearResources = [...catalog.resources].filter(
      ([filePath]) =>
        filePath.includes("/apps/android/wear/src/main/res/values-") &&
        filePath.endsWith("/strings.xml"),
    );
    const base = await readFile("apps/android/wear/src/main/res/values/strings.xml", "utf8");
    const baseKeys = [...base.matchAll(/<string name="([^"]+)"/gu)]
      .map((match) => match[1])
      .toSorted();
    const basePlaceholders = [...base.matchAll(/%\d+\$[a-z]/giu)]
      .map((match) => match[0])
      .toSorted();

    expect(wearResources).toHaveLength(NATIVE_I18N_LOCALES.length);
    for (const [, content] of wearResources) {
      const stringTags = [...content.matchAll(/<string\b[^>]*>/gu)].map((match) => match[0]);
      const keys = stringTags
        .map((tag) => tag.match(/\bname="([^"]+)"/u)?.[1])
        .filter((key): key is string => key !== undefined)
        .toSorted();
      const placeholders = [...content.matchAll(/%\d+\$[a-z]/giu)]
        .map((match) => match[0])
        .toSorted();
      expect(keys).toEqual(baseKeys);
      expect(placeholders).toEqual(basePlaceholders);
      expect(content).not.toMatch(/(?:&apos;|(?<!\\)')/u);
      expect(content).toContain('<resources xmlns:tools="http://schemas.android.com/tools">');
      for (const tag of stringTags) {
        if (!tag.includes('translatable="false"')) {
          expect(tag).toContain('tools:ignore="Typos,TypographyDashes,TypographyEllipsis"');
        }
      }
    }
  });

  it("builds complete third-party flavor resources for every native locale", async () => {
    const catalog = await buildAndroidAppI18nCatalog();
    const base = await readFile(
      "apps/android/app/src/thirdParty/res/values/accessibility_strings.xml",
      "utf8",
    );
    const resources = [...catalog.resources].filter(
      ([filePath]) =>
        filePath.includes("/apps/android/app/src/thirdParty/res/values-") &&
        filePath.endsWith("/accessibility_strings.xml"),
    );

    expect(base).toContain('tools:ignore="MissingTranslation"');
    expect(resources).toHaveLength(NATIVE_I18N_LOCALES.length);
    for (const [, content] of resources) {
      expect(content).toContain('name="accessibility_service_label"');
      expect(content).toContain('name="accessibility_dev_activity_label"');
    }
  });

  it("preserves the existing Swedish app name", async () => {
    const strings = await readFile("apps/android/app/src/main/res/values-sv/strings.xml", "utf8");
    expect(strings).toContain('<string name="app_name">OpenClaw-nod</string>');
  });

  it("counts Kotlin and XML resource references", () => {
    expect(
      findUnusedAndroidResourceKeys(
        ["kotlin_only", "manifest_only", "values_only", "unused"],
        [
          { path: "Example.kt", source: "R.string.kotlin_only" },
          {
            path: "AndroidManifest.xml",
            source:
              'android:label="@string/manifest_only" <string name="alias">@string/values_only</string>',
          },
        ],
      ),
    ).toEqual(["unused"]);
  });

  it("requires exact Android resource reference identifiers", () => {
    expect(
      findUnusedAndroidResourceKeys(
        ["native_status", "native_status_detail", "native_unused"],
        [{ path: "Example.kt", source: "R.string.native_status_detail" }],
      ),
    ).toEqual(["native_status", "native_unused"]);
  });

  it("ignores Android resource references that only appear in comments", () => {
    expect(
      findUnusedAndroidResourceKeys(
        ["kotlin_comment", "block_comment", "xml_comment", "live"],
        [
          {
            path: "Example.kt",
            source: `
              // R.string.kotlin_comment
              /* R.string.block_comment */
              val endpoint = "https://example.test"
              val marker = "/* not a comment */"
              R.string.live
            `,
          },
          {
            path: "AndroidManifest.xml",
            source: "<!-- @string/xml_comment -->",
          },
        ],
      ),
    ).toEqual(["kotlin_comment", "block_comment", "xml_comment"]);
  });

  it("ignores Android resource references inside Kotlin strings", () => {
    expect(
      findUnusedAndroidResourceKeys(
        ["regular_string", "raw_string", "live"],
        [
          {
            path: "Example.kt",
            source: `
              val regular = "R.string.regular_string"
              val raw = """R.string.raw_string"""
              R.string.live
            `,
          },
        ],
      ),
    ).toEqual(["regular_string", "raw_string"]);
  });

  it("selects duplicate-source translations by frequency then stable text order", () => {
    expect(selectDeterministicTranslation("Source", ["Beta", "Alpha", "Beta"])).toBe("Beta");
    expect(selectDeterministicTranslation("Source", ["Beta", "Alpha"])).toBe("Alpha");
  });

  it("prefers a translated candidate over repeated source fallbacks", () => {
    expect(selectDeterministicTranslation("Source", ["Source", "Translated", "Source"])).toBe(
      "Translated",
    );
    expect(selectDeterministicTranslation("Source", ["Source", "Source"])).toBe("Source");
  });

  it("preserves a localized resource when translation memory retires its UI source", () => {
    expect(decodeAndroidResourceValue('"Sitzungen"')).toBe("Sitzungen");
    expect(decodeAndroidResourceValue('"Sag \\"Hallo\\""')).toBe('Sag "Hallo"');
    const existing = { source: "Sessions", translation: "Sitzungen" };
    expect(selectGeneratedTranslation("Sessions", [], existing)).toBe("Sitzungen");
    expect(selectGeneratedTranslation("Sessions", ["Sesiones"], existing)).toBe("Sesiones");
  });

  it("selects Wear translations by inventory ID instead of shared English source", () => {
    const artifacts = new Map([
      ["native.android.phone", { source: "Connected", translated: "Phone translation" }],
      ["native.android.wear", { source: "Connected", translated: "Wear translation" }],
    ]);

    expect(selectExactArtifactTranslation("Connected", "native.android.wear", artifacts)).toBe(
      "Wear translation",
    );
    expect(selectExactArtifactTranslation("Connected", "native.android.missing", artifacts)).toBe(
      "Connected",
    );
  });

  it("does not reuse a localized resource after its English source changes", () => {
    const existing = { source: "Sessions", translation: "Sitzungen" };
    expect(selectGeneratedTranslation("Threads", [], existing)).toBe("");
  });

  it("preserves source argument indexes when a translation reorders interpolations", () => {
    expect(
      renderAndroidResourceValue(
        "$readyProviderCount of $providerCount providers ready",
        "$providerCount Anbieter, davon $readyProviderCount bereit",
      ),
    ).toBe("%2$s Anbieter, davon %1$s bereit");
  });

  it("formats nested Kotlin interpolations as single Android arguments", () => {
    expect(
      renderAndroidResourceValue(
        "${device.tokens.count { !it.revoked }}/${device.tokens.size} active tokens",
        "${device.tokens.size} Token, ${device.tokens.count { !it.revoked }} aktiv",
      ),
    ).toBe("%2$s Token, %1$s aktiv");
  });

  it("preserves Android resource placeholders outside Kotlin interpolation", () => {
    expect(escapeAndroidResourceValue("Previous %1$s")).toBe("Previous %1$s");
  });

  it("balances braces inside nested interpolation strings", () => {
    expect(
      renderAndroidResourceValue(
        '${if (connected) "{" else "}"} $count',
        '$count · ${if (connected) "{" else "}"}',
      ),
    ).toBe("%2$s · %1$s");
  });

  it("rejects repeated translation placeholders that do not match the source", () => {
    expect(() =>
      renderAndroidResourceValue("$item then $item", "$item, $item und noch einmal $item"),
    ).toThrow("Android translation changed interpolation placeholders");
  });

  it("finds direct, typed, conditional, interpolated, Elvis, and accessibility literals", () => {
    const source = `
      data class ConnectionState(
        val connected: Boolean,
        val statusText: String,
      )
      data class SettingsToggleRow(
        val title: String,
        val subtitle: String,
      )

      Text("Settings")
      Text(text = nativeStringResource("Connected"))
      ClawPrimaryButton(text = "Continue", onClick = {})
      ClawStatusPill(text = "Working")
      SettingsMetric("Gateway", gatewayName)
      ConnectionState(connected = false, statusText = "Connecting to $host")
      ConnectionState(connected = true, statusText = nativeString("Connected"))
      SettingsToggleRow("Phone capability", "Share device data")
      SettingsToggleRow(nativeString("Localized capability"), nativeString("Localized detail"))
      Text(text = fileName ?: "Attachment")
      Modifier.clickable(onClickLabel = "Open detail", onClick = {})
      Text(nativeString("First sentence. ") + "Second sentence.")
      val dynamic = Text(text = gateway.name)

      fun statusText(state: State): String =
        when (state) {
          State.Ready -> "Ready"
          State.Waiting -> nativeString("Waiting")
        }
    `;
    expect(
      findUnlocalizedAndroidUiLiterals(
        source,
        "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
      ),
    ).toEqual([
      expect.objectContaining({ source: "Settings" }),
      expect.objectContaining({ source: "Continue" }),
      expect.objectContaining({ source: "Working" }),
      expect.objectContaining({ source: "Gateway" }),
      expect.objectContaining({ source: "Connecting to $host" }),
      expect.objectContaining({ source: "Phone capability" }),
      expect.objectContaining({ source: "Share device data" }),
      expect.objectContaining({ source: "Attachment" }),
      expect.objectContaining({ source: "Open detail" }),
      expect.objectContaining({ source: "Second sentence." }),
      expect.objectContaining({ source: "Ready" }),
    ]);
    expect(
      findUnlocalizedAndroidUiLiterals(
        source,
        "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
      ).map((finding) => finding.source),
    ).not.toEqual(expect.arrayContaining(["Connected", "Waiting"]));
  });

  it("maps typed model fields across generic types and named argument omissions", () => {
    const source = `
      data class GenericState<T : Map<String, String>>(
        val metadata: Map<String, String>,
        val statusText: String,
      )
      data class OptionalState(
        val statusText: String = "",
        val code: String,
      )

      GenericState<Map<String, String>>(emptyMap(), "Generic ready")
      OptionalState(code = "Internal code")
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toContain("Generic ready");
    expect(findings).not.toContain("Internal code");
  });

  it("scans helpers with generic and lambda parameters", () => {
    const source = `
      fun <T> statusText(value: T, transform: (T) -> String): String =
        if (transform(value).isBlank()) "No status" else nativeString("Ready")
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toContain("No status");
    expect(findings).not.toContain("Ready");
  });

  it("finds raw strings in direct UI and presentation helpers", () => {
    const source = `
      Text("""Direct raw copy""")

      fun diagnosticsReport(): String =
        """
          Raw helper copy
        """.trimIndent()
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toEqual(
      expect.arrayContaining(["Direct raw copy", expect.stringContaining("Raw helper copy")]),
    );
  });

  it("inventories command, attention, and overview model display literals", () => {
    const source = `
      data class CommandItem(
        val key: String,
        val title: String,
        val subtitle: String,
      )
      data class HomeAttentionRow(
        val title: String,
        val subtitle: String,
        val route: String,
      )
      data class OverviewMetricCardSpec(
        val title: String,
        val value: String,
        val subtitle: String,
      )

      CommandItem("chat", "Open Chat", "Start a conversation")
      CommandItem(
        key = "voice",
        title = nativeString("Start Voice"),
        subtitle = nativeString("Talk with OpenClaw"),
      )
      HomeAttentionRow(
        title = "Gateway",
        subtitle = "Connect before chat, voice, and live status.",
        route = "gateway",
      )
      OverviewMetricCardSpec(
        title = nativeString("Gateway"),
        value = if (connected) "Online" else nativeString("Offline"),
        subtitle = "All systems nominal",
      )
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toEqual(
      expect.arrayContaining([
        "Open Chat",
        "Start a conversation",
        "Gateway",
        "Connect before chat, voice, and live status.",
        "Online",
        "All systems nominal",
      ]),
    );
    expect(findings).not.toEqual(
      expect.arrayContaining([
        "chat",
        "voice",
        "Start Voice",
        "Talk with OpenClaw",
        "Offline",
        "gateway",
      ]),
    );
  });

  it("requires exact String fields and scans multiline helper expressions", () => {
    const source = `
      data class StringResource(val key: String)
      data class ResourceState(val statusText: StringResource)

      ResourceState(statusText = StringResource("resource_key"))

      fun errorText(failed: Boolean): String =
        if (failed) {
          "Failure"
        } else {
          nativeString("Ready")
        }

      fun helperText(value: String?): String =
        value
          ?: "Fallback"
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toEqual(expect.arrayContaining(["Failure", "Fallback"]));
    expect(findings).not.toEqual(expect.arrayContaining(["resource_key", "Ready"]));
  });

  it("ignores preview fixtures", () => {
    expect(
      findUnlocalizedAndroidUiLiterals(
        'Text("Preview copy")',
        "apps/android/app/src/main/java/ai/openclaw/app/ui/design/ClawComponents.kt",
      ),
    ).toEqual([]);
  });

  it("scans Wear presentation sources but ignores Wear screenshot fixtures", () => {
    const source = `
      data class WearSession(val title: String)
      WearSession(title = "Current session")
    `;
    expect(
      findUnlocalizedAndroidUiLiterals(
        source,
        "apps/android/wear/src/main/java/ai/openclaw/wear/WearViewModel.kt",
      ).map((finding) => finding.source),
    ).toContain("Current session");
    expect(
      findUnlocalizedAndroidUiLiterals(
        source,
        "apps/android/wear/src/main/java/ai/openclaw/wear/WearScreenshotMode.kt",
      ),
    ).toEqual([]);
  });

  it("scans flavor-specific activity surfaces", () => {
    expect(
      findUnlocalizedAndroidUiLiterals(
        'Text("Developer surface")',
        "apps/android/app/src/thirdParty/java/ai/openclaw/app/accessibility/AccessibilityDevActivity.kt",
      ).map((finding) => finding.source),
    ).toEqual(["Developer surface"]);
  });
});
