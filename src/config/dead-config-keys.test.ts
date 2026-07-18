// Verifies schema-only config keys stay outside the canonical config contract.
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

function expectUnknownKey(params: { config: Record<string, unknown>; path: string; key: string }) {
  const result = validateConfigObjectRaw(params.config);
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  const issue = result.issues.find(
    (candidate) =>
      candidate.path === params.path &&
      candidate.message.includes(`Unrecognized key: "${params.key}"`),
  );
  if (!issue) {
    throw new Error(`Expected unknown ${params.path}.${params.key} validation issue`);
  }
}

describe("dead config keys", () => {
  it("rejects retired audio.transcription", () => {
    expectUnknownKey({
      config: { audio: { transcription: { command: ["whisper"] } } },
      path: "",
      key: "audio",
    });
  });

  it("rejects legacy session.maintenance.rotateBytes", () => {
    expectUnknownKey({
      config: { session: { maintenance: { rotateBytes: "10mb" } } },
      path: "session.maintenance",
      key: "rotateBytes",
    });
  });

  it("rejects unused gateway.remote.enabled", () => {
    expectUnknownKey({
      config: { gateway: { remote: { enabled: false } } },
      path: "gateway.remote",
      key: "enabled",
    });
  });
});
