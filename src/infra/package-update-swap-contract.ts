// Public contracts shared by package activation and its existing callers.
import type {
  PackageRecoveryTransaction,
  PackageRecoveryResult,
} from "./package-update-recovery.js";
import type { NpmGlobalPrefixLayout, ResolvedGlobalInstallTarget } from "./update-global.js";
import type { NativePackageStage } from "./update-native-package-stage.js";
import type { UpdateStepResult } from "./update-runner-types.js";

/** The orchestrator owns schema safety and service verification before confirming or restoring. */
export type PackageUpdateTransaction = {
  backupRoot: string;
  recovery?: PackageRecoveryTransaction;
  assertRollbackSafe?: () => Promise<void>;
  rollback: () => Promise<
    UpdateStepResult & { activePackageRoot: string | null; reason?: "rollback-project-changed" }
  >;
  complete: (outcome: { activationVerified: boolean }) => Promise<UpdateStepResult | void>;
};

// Service suspension and cancellation belong to the caller. Carry their exact
// cause through package failure handling without reclassifying service safety.
export class PackageUpdateActivationError extends Error {
  constructor(cause: unknown) {
    super("Package activation preparation failed", { cause });
  }
}

export type StagedPackageInstall = {
  prefix: string;
  layout: NpmGlobalPrefixLayout;
  packageRoot: string;
  installTarget: ResolvedGlobalInstallTarget;
  native?: NativePackageStage;
};

export type StagedPackageSwapResult =
  | {
      status: "committed";
      activePackageRoot: string | null;
      step: UpdateStepResult;
      postVerifyStep: UpdateStepResult | null;
    }
  | {
      status: "failed";
      activePackageRoot: string | null;
      step: UpdateStepResult;
      postVerifyStep: UpdateStepResult | null;
      packageRollbackVerified: boolean;
      recovery?: PackageRecoveryResult;
    };
