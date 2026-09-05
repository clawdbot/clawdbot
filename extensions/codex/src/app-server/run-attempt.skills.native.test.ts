import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import {
  createNativeRunParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

setupRunAttemptTestHooks();
vi.unmock("node:child_process");

describe("native Codex skill delivery", () => {
  it("delivers the ordinary root catalog when model metadata owns collaboration instructions", async () => {
    const root = await fs.realpath(tempDir);
    const native = await createCodexNativeTestState(root);
    for (const [name, value] of Object.entries(native.env)) {
      if (value !== undefined) {
        vi.stubEnv(name, value);
      }
    }
    const requests: JsonObject[] = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const parsed: unknown = JSON.parse(body);
        if (!isJsonObject(parsed)) {
          response.writeHead(400).end();
          return;
        }
        requests.push(parsed);
        const events = [
          { type: "response.created", response: { id: "skill-response" } },
          {
            type: "response.completed",
            response: {
              id: "skill-response",
              usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
            },
          },
        ];
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback provider address");
    }
    const modelId = "skill-carrier-model";
    const catalogPath = path.join(root, "models.json");
    await fs.writeFile(
      catalogPath,
      JSON.stringify({
        models: [
          {
            slug: modelId,
            display_name: "Synthetic skill carrier model",
            supported_reasoning_levels: [],
            shell_type: "local",
            visibility: "list",
            supported_in_api: true,
            priority: 1,
            support_verbosity: false,
            truncation_policy: { mode: "bytes", limit: 10000 },
            experimental_supported_tools: [],
            context_window: 200000,
            model_messages: {
              instructions_template: "You are a test assistant.",
              collaboration_modes: { default: "Synthetic model-owned Default policy." },
            },
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(native.codexHome, "config.toml"),
      [
        `model=${JSON.stringify(modelId)}`,
        'model_provider="skill-fixture"',
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
        'cli_auth_credentials_store="ephemeral"',
        'web_search="disabled"',
        'approval_policy="never"',
        'sandbox_mode="read-only"',
        "[model_providers.skill-fixture]",
        'name="Synthetic skill provider"',
        `base_url="http://127.0.0.1:${address.port}/v1"`,
        'wire_api="responses"',
        "requires_openai_auth=false",
        "supports_websockets=false",
        "request_max_retries=0",
        "stream_max_retries=0",
      ].join("\n"),
    );
    let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
    try {
      const params = createNativeRunParams(path.join(root, "session.jsonl"), native.cwd);
      params.modelId = modelId;
      params.model = { ...params.model, id: modelId };
      params.prompt = "What is the weather in Wilmington today?";
      params.trigger = "user";
      params.timeoutMs = 20_000;
      const otherSkills = Array.from(
        { length: 40 },
        (_, index) =>
          `<skill><name>synthetic-${index}</name><description>${"Unrelated task capability. ".repeat(8)}</description><location>/synthetic/${index}/SKILL.md</location></skill>`,
      ).join("");
      params.skillsSnapshot = {
        prompt: `<available_skills>${otherSkills}<skill><name>weather</name><description>Current weather and forecasts.</description><location>/synthetic/weather/SKILL.md</location></skill></available_skills>`,
        skills: [],
      };
      const result = await runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: { command: native.command, args: ["app-server"], homeScope: "user" },
        },
        nativeHookRelay: { enabled: false },
        clientFactory: async (options) => {
          client = await createIsolatedCodexAppServerClient(options);
          return client;
        },
      });
      expect(result.terminal).toEqual({ kind: "ok" });
      expect(requests).toHaveLength(1);
      const input = requests[0]?.input;
      expect(Array.isArray(input)).toBe(true);
      const developerMessages = Array.isArray(input)
        ? input.filter((item) => isJsonObject(item) && item.role === "developer")
        : [];
      const developerText = JSON.stringify(developerMessages);
      expect(developerText).toContain("Synthetic model-owned Default policy.");
      expect(developerText).toContain(params.skillsSnapshot.prompt);
    } finally {
      if (client) {
        expect(await client.closeAndWait()).toBe(true);
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 45_000);
});
