import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { assertCodexPassiveTurnItems } from "./protocol-validators.js";
import type { CodexModelListResponse } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_OUTPUT_SCHEMA === "1";
const describeLive = LIVE ? describe : describe.skip;

afterEach(() => {
  vi.unstubAllEnvs();
});

describeLive("Codex isolated completion real-binary structured output", () => {
  it("accepts a native schema and recovers from a rejected native dialect", async () => {
    await withTempDir("openclaw-codex-output-schema-", async (root) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const codexEntry = path.resolve(
        import.meta.dirname,
        "../../node_modules/@openai/codex/bin/codex.js",
      );
      const client = await createIsolatedCodexAppServerClient({
        startOptions: {
          transport: "stdio",
          homeScope: "user",
          command: process.execPath,
          commandSource: "config",
          args: [codexEntry, "app-server", "--stdio"],
          headers: {},
        },
        agentDir: workspace,
        authProfileId: null,
        timeoutMs: 120_000,
      });
      try {
        const listed = await client.request<CodexModelListResponse>(
          "model/list",
          { limit: 100, cursor: null, includeHidden: false },
          { timeoutMs: 60_000 },
        );
        const modelId =
          listed.data.find((model) => model.isDefault)?.model ?? listed.data[0]?.model;
        if (!modelId) {
          throw new Error("Codex model/list returned no models");
        }

        const result = await runBoundedCodexAppServerTurn({
          model: { mode: "required", id: modelId },
          timeoutMs: 120_000,
          agentDir: workspace,
          options: { clientFactory: async () => client },
          taskLabel: "structured-output live test",
          developerInstructions: "Return only the requested structured result.",
          input: [
            {
              type: "text",
              text: "Set answer to exactly LIVE_SCHEMA_OK.",
              text_elements: [],
            },
          ],
          outputSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
          requiredModalities: ["text"],
          isolation: "configured-transport",
          requireNoExternalCapabilities: true,
        });

        expect(JSON.parse(result.text)).toEqual({ answer: "LIVE_SCHEMA_OK" });

        const fallback = await runBoundedCodexAppServerTurn({
          model: { mode: "required", id: modelId },
          timeoutMs: 120_000,
          agentDir: workspace,
          options: { clientFactory: async () => client },
          taskLabel: "structured-output compatibility live test",
          developerInstructions: "Return only the requested JSON result.",
          input: [
            {
              type: "text",
              text: "Set answer to exactly LIVE_FALLBACK_OK.",
              text_elements: [],
            },
          ],
          // Valid JSON Schema, but broader than Codex's native strict subset.
          outputSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
          requiredModalities: ["text"],
          isolation: "configured-transport",
          requireNoExternalCapabilities: true,
        });

        expect(JSON.parse(fallback.text)).toEqual({ answer: "LIVE_FALLBACK_OK" });
        expect(fallback.submittedInput).toHaveLength(2);
        assertCodexPassiveTurnItems(
          fallback.items,
          fallback.submittedInput,
          "structured-output compatibility live test",
        );
      } finally {
        await client.closeAndWait();
      }
    });
  }, 180_000);
});
