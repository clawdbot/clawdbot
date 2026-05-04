import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("legacy config migrate validation", () => {
  it("returns migrated config when unrelated plugin validation issues remain (#76798)", () => {
    const res = migrateLegacyConfig({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          llm: { idleTimeoutSeconds: 120 },
        },
      },
      plugins: {
        entries: {
          brave: {
            enabled: true,
            config: { webSearch: { mode: "definitely-invalid" } },
          },
        },
      },
      tools: { web: { search: { provider: "brave" } } },
    });

    expect(res.partiallyValid).toBe(true);
    expect(res.changes).toContain(
      "Removed agents.defaults.llm; model idle timeout now follows models.providers.<id>.timeoutSeconds.",
    );
    expect(res.changes).toContain(
      "Migration applied; other validation issues remain — run doctor to review.",
    );
    expect(res.config?.agents?.defaults).toEqual({
      model: { primary: "openai/gpt-5.5" },
    });
    expect(res.config?.tools?.web?.search?.provider).toBe("brave");
  });
});
