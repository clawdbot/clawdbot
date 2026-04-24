import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIELD_HELP } from "./schema.help.js";
import {
  describeTalkSilenceTimeoutDefaults,
  TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM,
} from "./talk-defaults.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("talk silence timeout defaults", () => {
  it("keeps help text and docs aligned with the policy", () => {
    const defaultsDescription = describeTalkSilenceTimeoutDefaults();

    expect(FIELD_HELP["talk.silenceTimeoutMs"]).toContain(defaultsDescription);
    expect(readRepoFile("docs/gateway/config-agents.md")).toContain(defaultsDescription);
    expect(readRepoFile("docs/nodes/talk.md")).toContain(defaultsDescription);
  });

  it("matches the Apple and Android runtime constants", () => {
    const macDefaults = readRepoFile("apps/macos/Sources/OpenClaw/TalkDefaults.swift");
    const iosDefaults = readRepoFile("apps/ios/Sources/Voice/TalkDefaults.swift");
    const androidDefaults = readRepoFile(
      "apps/android/app/src/main/java/ai/openclaw/app/voice/TalkDefaults.kt",
    );

    expect(macDefaults).toContain(
      `static let silenceTimeoutMs = ${TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.macos}`,
    );
    expect(iosDefaults).toContain(
      `static let silenceTimeoutMs = ${TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.ios}`,
    );
    expect(androidDefaults).toContain(
      `const val defaultSilenceTimeoutMs = ${TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.android}L`,
    );
  });
});
