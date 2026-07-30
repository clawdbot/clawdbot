// Legacy config migration validation tests cover schema validation after doctor migrations.
import { beforeAll, describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("legacy config migrate validation", () => {
  let profileConfiguredToolAllowResult: ReturnType<typeof migrateLegacyConfig>;

  beforeAll(() => {
    profileConfiguredToolAllowResult = migrateLegacyConfig({
      tools: {
        profile: "messaging",
        allow: ["message", "exec", "process"],
        exec: { security: "allowlist" },
      },
    });
  });

  it("returns valid config when migrating profiled tool sections with an existing allowlist", () => {
    const res = profileConfiguredToolAllowResult;

    expect(res.partiallyValid).toBeUndefined();
    expect(res.config?.tools?.allow).toEqual(["message", "exec", "process"]);
    expect(res.config?.tools?.profile).toBe("full");
    expect(res.config?.tools?.alsoAllow).toBeUndefined();
    expect(res.changes).toStrictEqual([
      'Replaced tools.allow entries with profile "messaging" grants plus explicit configured-section grants.',
      'Set tools.profile to "full" so tools.allow controls explicit configured-section grants directly.',
    ]);
  });
});
