import { findSourceImportBackedges } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

describe("Codex prepared-runtime registration import boundary", () => {
  it("publishes descriptors without preparing models or loading live session/config diagnostics", async () => {
    expect(
      await findSourceImportBackedges("extensions/codex/index.ts", [
        "src/agents/prepared-model-runtime.ts",
        "src/agents/simple-completion-runtime.ts",
        "src/agents/agent-tools.ts",
        "src/logging/diagnostic.ts",
        "src/config/io.ts",
        "src/config/io.factory.ts",
        "src/config/sessions/session-accessor.ts",
        "src/infra/exec-approvals-store.ts",
        "src/gateway/session-transcript-readers.ts",
        "src/infra/provider-usage.fetch.claude.ts",
        "src/infra/provider-usage.fetch.codex.ts",
        "src/infra/provider-usage.fetch.deepseek.ts",
        "src/infra/provider-usage.fetch.gemini.ts",
        "src/infra/provider-usage.fetch.minimax.ts",
        "src/infra/provider-usage.fetch.zai.ts",
        "src/agents/provider-request-config.ts",
        "src/plugins/manifest-registry-installed.ts",
        "src/sessions/session-upstream-links.ts",
        "src/state/openclaw-state-db.ts",
        "src/infra/net/undici-runtime.ts",
        "src/plugin-sdk/text-chunking.ts",
        "extensions/codex/src/app-server/protocol-validators.ts",
      ]),
    ).toEqual([]);
  });

  it("registers connection health without loading network configuration execution", async () => {
    expect(
      await findSourceImportBackedges("extensions/codex/src/app-server/connection-health.ts", [
        "src/infra/net/undici-runtime.ts",
      ]),
    ).toEqual([]);
  });

  it("resolves native runtime options without host approval storage or model selection", async () => {
    expect(
      await findSourceImportBackedges("extensions/codex/src/app-server/config-runtime.ts", [
        "src/infra/exec-approvals-store.ts",
        "src/agents/model-selection-resolve.ts",
      ]),
    ).toEqual([]);
  });
});
