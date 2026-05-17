import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

function isLegacyMemoryPressureBundleConfig(value: unknown): boolean {
  return typeof value === "boolean" || getRecord(value) !== null;
}

const MEMORY_PRESSURE_BUNDLE_RULE: LegacyConfigRule = {
  path: ["diagnostics", "memoryPressureBundle"],
  message:
    'diagnostics.memoryPressureBundle was renamed; use diagnostics.memoryPressureSnapshot instead. Run "openclaw doctor --fix".',
  match: isLegacyMemoryPressureBundleConfig,
  requireSourceLiteral: true,
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "diagnostics.memoryPressureBundle->memoryPressureSnapshot",
    describe: "Move diagnostics.memoryPressureBundle to diagnostics.memoryPressureSnapshot",
    legacyRules: [MEMORY_PRESSURE_BUNDLE_RULE],
    apply: (raw, changes) => {
      const diagnostics = getRecord(raw.diagnostics);
      if (!diagnostics || !isLegacyMemoryPressureBundleConfig(diagnostics.memoryPressureBundle)) {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(diagnostics, "memoryPressureSnapshot")) {
        delete diagnostics.memoryPressureBundle;
        changes.push(
          "Removed diagnostics.memoryPressureBundle (memoryPressureSnapshot already set).",
        );
        return;
      }
      const legacy = getRecord(diagnostics.memoryPressureBundle);
      diagnostics.memoryPressureSnapshot =
        typeof diagnostics.memoryPressureBundle === "boolean"
          ? diagnostics.memoryPressureBundle
          : legacy?.enabled !== false;
      delete diagnostics.memoryPressureBundle;
      changes.push("Moved diagnostics.memoryPressureBundle → memoryPressureSnapshot.");
    },
  }),
];
