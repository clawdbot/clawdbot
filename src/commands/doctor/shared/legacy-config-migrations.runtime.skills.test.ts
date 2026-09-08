import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS } from "./legacy-config-migrations.runtime.skills.js";

function migrate(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

describe("Skill Workshop autonomy config migration", () => {
  it.each([
    { enabled: true, mode: "propose" },
    { enabled: false, mode: "off" },
  ] as const)("maps enabled=$enabled to $mode", ({ enabled, mode }) => {
    const result = migrate({
      skills: { workshop: { autonomous: { enabled } } },
    });

    expect(result.raw).toEqual({
      skills: { workshop: { autonomous: { mode } } },
    });
    expect(result.changes).toEqual([
      `Mapped skills.workshop.autonomous.enabled to mode: "${mode}".`,
    ]);
  });

  it("leaves an absent legacy key absent so the new auto default applies", () => {
    const result = migrate({ skills: { workshop: { autonomous: {} } } });

    expect(result.raw).toEqual({ skills: { workshop: { autonomous: {} } } });
    expect(result.changes).toEqual([]);
  });

  it("drops the retired symlink write option", () => {
    const result = migrate({
      skills: {
        workshop: {
          allowSymlinkTargetWrites: true,
          autonomous: { mode: "auto" },
        },
      },
    });

    expect(result.raw).toEqual({
      skills: { workshop: { autonomous: { mode: "auto" } } },
    });
    expect(result.changes).toEqual([
      "Removed retired skills.workshop.allowSymlinkTargetWrites; Skill Workshop writes only inside its own directory.",
    ]);
  });
});
