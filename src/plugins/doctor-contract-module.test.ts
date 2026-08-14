import { describe, expect, it, vi } from "vitest";
import { coercePluginDoctorContractModule } from "./doctor-contract-module.js";

describe("doctor contract module coercion", () => {
  it("preserves startup preflight hooks on valid state migrations", () => {
    const preflightStartup = vi.fn(() => ({ status: "ready" as const }));
    const detectLegacyState = vi.fn(() => null);
    const migrateLegacyState = vi.fn(() => ({ changes: [], warnings: [] }));

    const result = coercePluginDoctorContractModule({
      stateMigrations: [
        {
          id: " sample ",
          label: " Sample migration ",
          preflightStartup,
          detectLegacyState,
          migrateLegacyState,
        },
      ],
    });

    expect(result.stateMigrations).toEqual([
      {
        id: "sample",
        label: "Sample migration",
        doctorOnly: undefined,
        preflightStartup,
        detectLegacyState,
        migrateLegacyState,
      },
    ]);
  });
});
