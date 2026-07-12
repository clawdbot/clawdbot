import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  checkAndroidAppI18n,
  findUnusedAndroidResourceKeys,
  findUnlocalizedAndroidUiLiterals,
  renderAndroidResourceValue,
  selectDeterministicTranslation,
} from "../../scripts/android-app-i18n.ts";

describe("Android app i18n resources", () => {
  it("keeps generated resources, runtime coverage, and every locale aligned", async () => {
    await expect(checkAndroidAppI18n()).resolves.toBeUndefined();
    const base = await readFile("apps/android/app/src/main/res/values/strings.xml", "utf8");
    expect(base).toContain('xmlns:tools="http://schemas.android.com/tools"');
    expect(base).toMatch(
      /<string name="native_[a-f0-9]+"[^>]*tools:ignore="Typos,TypographyDashes,TypographyEllipsis">/u,
    );
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
});
