import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignNativeI18nIds,
  collectNativeI18nEntries,
  isConditionalBranchIdentifier,
  NATIVE_I18N_LOCALES,
  parseNativeI18nCommand,
  syncNativeLocale,
  type NativeI18nEntry,
} from "../../scripts/native-app-i18n.ts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

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
    expect(
      assignNativeI18nIds(
        [reclassified],
        [{ ...candidate, id: "native.apple.existing-translation" }],
      )[0]?.id,
    ).toBe("native.apple.existing-translation");
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

  it("collects stable Android and Apple UI entries", async () => {
    const entries = await collectNativeI18nEntries();
    const surfaces = new Set(entries.map((entry) => entry.surface));

    expect(entries.length).toBeGreaterThan(100);
    expect(surfaces).toEqual(new Set(["android", "apple"]));
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
    expect(
      entries
        .filter((entry) => entry.surface === "apple")
        .every((entry) =>
          /^(?:apps\/ios|apps\/macos\/Sources|apps\/shared\/OpenClawKit\/Sources)\//u.test(
            entry.path,
          ),
        ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "QR Scanner Unavailable")).toBe(true);
    expect(entries.some((entry) => entry.source === "Request ID: \\(value)")).toBe(true);
    expect(entries.some((entry) => entry.source === "Open ${row.title}")).toBe(true);
    expect(entries.some((entry) => entry.source === "Preview · $domain")).toBe(true);
    expect(entries.some((entry) => entry.source === "Approval command copied")).toBe(true);
    expect(entries.some((entry) => entry.source === "Save Profile")).toBe(true);
    expect(entries.some((entry) => entry.source === "Mute")).toBe(true);
    expect(entries.some((entry) => entry.source === "Creating...")).toBe(true);
    expect(entries.some((entry) => entry.source === "Permission required")).toBe(true);
    expect(entries.some((entry) => entry.source === "Needs setup")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source === "Choose a supported ${issue.target.title} provider on the Gateway",
      ),
    ).toBe(true);
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
      entries.some(
        (entry) =>
          entry.surface === "android" &&
          entry.kind === "ui-named-argument" &&
          entry.source === "Search OpenClaw",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path.endsWith("/ChatMessageActions.kt") &&
          entry.kind === "ui-named-argument" &&
          entry.source === "Message actions",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path.endsWith("/ChatMessageActions.kt") &&
          entry.kind === "ui-named-argument" &&
          entry.source === "Reply",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path.endsWith("/ChatMessageActions.kt") &&
          entry.kind === "ui-chooser" &&
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
          entry.path === "apps/ios/Sources/Design/TalkRuntimeIssueBanner.swift" &&
          entry.kind === "ui-named-argument" &&
          entry.source === "Details",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path === "apps/ios/Sources/Design/TalkRuntimeIssueBanner.swift" &&
          entry.kind === "ui-named-argument" &&
          entry.source === "Open Settings",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "No sessions yet")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path.endsWith("/ChatSheets.swift") &&
          entry.kind === "ui-named-argument" &&
          entry.source === "Search sessions",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "Don't show this again")).toBe(true);
    expect(entries.some((entry) => entry.source === "Use Manual Gateway")).toBe(true);
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
          "Approve this device on the gateway.\n1) `\\(commandLine)`\n2) `/pair approve` in your OpenClaw chat\n\\(requestLine)\nOpenClaw will also retry automatically when you return to this app.",
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
            "Can't reach gateway at \\(host):\\(port). Verify Tailscale Serve is enabled and publishes this Gateway.",
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
          "Let an authorized agent move the pointer, click, and type on this Mac. Also requires Accessibility, Screen Recording, and gateway command authorization. High risk.",
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

  it("creates a first-run locale artifact and leaves a complete artifact unchanged", async () => {
    const tempDirs: string[] = [];
    const translationsDir = makeTempDir(tempDirs, "openclaw-native-i18n-");
    const entries: NativeI18nEntry[] = [
      {
        id: "native.android.hello",
        kind: "ui-call",
        line: 1,
        path: "apps/android/example.kt",
        source: "Hello",
        surface: "android",
      },
      {
        id: "native.apple.request",
        kind: "ui-call",
        line: 2,
        path: "apps/ios/example.swift",
        source: "Request ID: \\(requestId)",
        surface: "apple",
      },
      {
        id: "native.android.count",
        kind: "ui-call",
        line: 3,
        path: "apps/android/example.kt",
        source: "Showing ${visibleApps.size} of ${apps.size}",
        surface: "android",
      },
      {
        id: "native.apple.permissions",
        kind: "ui-call",
        line: 4,
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
          line: 1,
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
          line: 1,
          path: "apps/ios/example.swift",
          source: "Send failed: %@",
          surface: "apple",
        },
        translated: "Sändningen misslyckades",
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

  it("validates locale refresh arguments before write paths run", () => {
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
  });
});
