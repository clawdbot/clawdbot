import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";
import { deleteRetiredPath } from "./legacy-config-record-shared.js";

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "skills.workshop.autonomous.enabled->mode",
    describe: "Migrate Skill Workshop autonomy to its three-position mode.",
    legacyRules: [
      {
        path: ["skills", "workshop", "autonomous", "enabled"],
        message:
          'skills.workshop.autonomous.enabled is retired; use skills.workshop.autonomous.mode. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const autonomous = getRecord(getRecord(getRecord(raw.skills)?.workshop)?.autonomous);
      if (!autonomous || !Object.hasOwn(autonomous, "enabled")) {
        return;
      }
      if (autonomous.mode === undefined) {
        const mode = autonomous.enabled === false ? "off" : "propose";
        autonomous.mode = mode;
        changes.push(`Mapped skills.workshop.autonomous.enabled to mode: "${mode}".`);
      } else {
        changes.push(
          "Removed skills.workshop.autonomous.enabled because autonomous.mode is already set.",
        );
      }
      delete autonomous.enabled;
    },
  }),
  defineLegacyConfigMigration({
    id: "skills.workshop.allowSymlinkTargetWrites-retired",
    describe: "Remove the retired Skill Workshop symlink write option.",
    legacyRules: [
      {
        path: ["skills", "workshop", "allowSymlinkTargetWrites"],
        message:
          'skills.workshop.allowSymlinkTargetWrites is retired; Skill Workshop writes only inside its own directory. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      if (deleteRetiredPath(raw, ["skills", "workshop", "allowSymlinkTargetWrites"])) {
        changes.push(
          "Removed retired skills.workshop.allowSymlinkTargetWrites; Skill Workshop writes only inside its own directory.",
        );
      }
    },
  }),
];
