// System-agent legacy config migration tests.
import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT } from "./legacy-config-migrations.runtime.system-agent.js";

const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT[0];

describe("system-agent config migration", () => {
  it("moves the retired config block", () => {
    const raw: Record<string, unknown> = {
      crestodian: { rescue: { enabled: true, pendingTtlMinutes: 10 } },
    };
    const changes: string[] = [];

    migration?.apply(raw, changes);

    expect(raw).toEqual({
      systemAgent: { rescue: { enabled: true, pendingTtlMinutes: 10 } },
    });
    expect(changes).toEqual(["Moved legacy crestodian config to systemAgent."]);
  });

  it("keeps explicit canonical values while filling missing values", () => {
    const raw: Record<string, unknown> = {
      crestodian: { rescue: { enabled: true, ownerDmOnly: false } },
      systemAgent: { rescue: { enabled: false } },
    };
    const changes: string[] = [];

    migration?.apply(raw, changes);

    expect(raw).toEqual({
      systemAgent: { rescue: { enabled: false, ownerDmOnly: false } },
    });
    expect(changes).toEqual([
      "Merged legacy crestodian config into systemAgent; kept explicit systemAgent values.",
    ]);
  });
});
