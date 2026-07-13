import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { orphanModelRefsCheck } from "./doctor-core-checks.js";

const mocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(async (): Promise<ModelCatalogEntry[]> => []),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: mocks.loadModelCatalog,
}));

const runtime = { log() {}, error() {}, exit() {} };

describe("core/doctor/orphan-model-refs", () => {
  beforeEach(() => {
    mocks.loadModelCatalog.mockReset();
    mocks.loadModelCatalog.mockResolvedValue([]);
  });

  it("does not report runtime catalog model refs just because models.providers is empty", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };

    await expect(orphanModelRefsCheck.detect({ mode: "doctor", runtime, cfg })).resolves.toEqual(
      [],
    );
  });

  it("reports and repairs stale model refs through the runtime catalog", async () => {
    mocks.loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);
    if (typeof orphanModelRefsCheck.repair !== "function") {
      throw new Error("expected orphan model ref check repair");
    }
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["ghostprovider/foo", "openai/gpt-5.5"],
          },
          models: {
            "ghostprovider/foo": {},
            "openai/gpt-5.5": {},
          },
        },
      },
    };

    const findings = await orphanModelRefsCheck.detect({ mode: "doctor", runtime, cfg });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/orphan-model-refs",
        severity: "warning",
        path: "agents.defaults.model.fallbacks.0",
      }),
      expect.objectContaining({
        checkId: "core/doctor/orphan-model-refs",
        severity: "warning",
        path: "agents.defaults.models.ghostprovider/foo",
      }),
    ]);

    await expect(orphanModelRefsCheck.repair({ mode: "fix", runtime, cfg })).resolves.toEqual(
      expect.objectContaining({
        config: {
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-5.5",
                fallbacks: ["openai/gpt-5.5"],
              },
              models: { "openai/gpt-5.5": {} },
            },
          },
        },
        changes: [
          "Removed stale model reference ghostprovider/foo at agents.defaults.model.fallbacks.0.",
          "Removed stale model reference ghostprovider/foo at agents.defaults.models.ghostprovider/foo.",
        ],
      }),
    );
  });
});
