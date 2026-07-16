import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { listCodexAppServerModels } from "./models.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

describe("listCodexAppServerModels", () => {
  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
  });

  it("lists app-server models through the typed helper", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({ limit: 12, timeoutMs: 1000 });
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.118.0 (macOS; test)" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
    const list = JSON.parse(harness.writes[2] ?? "{}") as { id?: number; method?: string };
    expect(list.method).toBe("model/list");

    harness.send({
      id: list.id,
      result: {
        data: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "gpt-5.4",
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "xhigh", description: "deep" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    });

    await expect(listPromise).resolves.toEqual({
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "gpt-5.4",
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: ["low", "xhigh"],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    });
    harness.client.close();
    startSpy.mockRestore();
  });
});
