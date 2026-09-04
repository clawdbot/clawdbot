import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

describe("per-agent legacy migrations after roster normalization", () => {
  it("does not create global model settings from a discarded legacy roster", () => {
    const result = applyLegacyDoctorMigrations({
      agents: {
        entries: { main: { name: "canonical" } },
        list: [
          { id: "old", model: "vllm/qwen-test", params: { qwenThinkingFormat: "chat-template" } },
        ],
      },
    });
    expect(result.next).toEqual({ agents: { entries: { main: { name: "canonical" } } } });
  });

  it.each(["entries", "list"])("preserves migrated values in a %s roster", (shape) => {
    const agent = {
      tools: { exec: { timeoutSec: 45 } },
      sandbox: { browser: { enableNoVnc: false } },
      tts: { enabled: true, providers: { custom: { voice: "operator-voice" } } },
      model: "vllm/qwen-test",
      params: { qwenThinkingFormat: "chat-template", temperature: 0.2 },
    };
    const raw: Record<string, unknown> = {
      agents: {
        ownership: "explicit",
        ...(shape === "entries"
          ? { entries: { worker: agent } }
          : { list: [{ id: "worker", ...agent }] }),
      },
    };
    expect(findLegacyConfigIssues(raw)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Final layout aliases") }),
        expect.objectContaining({ message: expect.stringContaining("tts.enabled") }),
        expect.objectContaining({ message: expect.stringContaining("qwenThinkingFormat") }),
      ]),
    );

    const changes: string[] = [];
    for (const migration of LEGACY_CONFIG_MIGRATIONS) {
      migration.apply(raw, changes);
    }

    expect(raw).toMatchObject({
      agents: {
        ownership: "explicit",
        entries: {
          worker: {
            tools: { exec: { timeoutSeconds: 45 } },
            sandbox: { browser: { noVncEnabled: false } },
            tts: { auto: "always", providers: { custom: { speakerVoice: "operator-voice" } } },
            params: { temperature: 0.2 },
          },
        },
      },
      models: {
        providers: {
          vllm: { models: [{ id: "qwen-test", compat: { thinkingFormat: "qwen-chat-template" } }] },
        },
      },
    });
    expect(raw).not.toHaveProperty("agents.entries.worker.params.qwenThinkingFormat");
    expect(raw).not.toHaveProperty("agents.entries.worker.tools.exec.timeoutSec");
    expect(raw).not.toHaveProperty("agents.entries.worker.sandbox.browser.enableNoVnc");
    expect(raw).not.toHaveProperty("agents.entries.worker.tts.enabled");
    expect(raw).not.toHaveProperty("agents.entries.worker.tts.providers.custom.voice");
  });
});
