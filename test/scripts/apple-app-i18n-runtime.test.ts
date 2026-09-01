import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileMacosLocalizations, verifyAppleAppI18n } from "../../scripts/apple-app-i18n.ts";

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
    // Append synthetic calls only to production-source reads; all other I/O stays real.
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const source = await actual.readFile(...args);
      const file = typeof args[0] === "string" ? args[0].replaceAll("\\", "/") : "";
      return typeof source === "string" && probe.paths.some((entry) => file.endsWith("/" + entry))
        ? source + "\n" + probe.source
        : source;
    },
  };
});

describe("Apple runtime interpolation gate", () => {
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
});
