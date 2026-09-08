import type { UpdateRunResult } from "../../infra/update-runner.js";
import { UpdatePreMutationError } from "./shared.js";
import {
  runPackageInstallUpdate,
  type PackageInstallUpdateParams,
} from "./update-command-package.js";

type PackageUpdatePreparation = Omit<PackageInstallUpdateParams, "managedServiceEnv">;

type PackageUpdateActivation = Pick<PackageInstallUpdateParams, "managedServiceEnv">;

declare const preparedPackageUpdateBrand: unique symbol;

export type PreparedPackageUpdate = Readonly<{
  [preparedPackageUpdateBrand]: true;
}>;

export type PackageUpdateExecutor = Readonly<{
  prepare(update: PackageUpdatePreparation): Promise<PreparedPackageUpdate>;
  activate(params: {
    prepared: PreparedPackageUpdate;
    activation: PackageUpdateActivation;
  }): Promise<UpdateRunResult>;
  discard(
    prepared: PreparedPackageUpdate,
    reason: "pre-activation-failed" | "update-aborted",
  ): Promise<void>;
}>;

type PackageExecutorImplementation<PreparedState> = {
  prepare(update: PackageUpdatePreparation): Promise<PreparedState>;
  activate(params: {
    prepared: PreparedState;
    activation: PackageUpdateActivation;
  }): Promise<UpdateRunResult>;
  discard?: (
    prepared: PreparedState,
    reason: "pre-activation-failed" | "update-aborted",
  ) => Promise<void>;
};

function createPreparedPackageUpdate(): PreparedPackageUpdate {
  // SAFETY: The owning WeakMap, not an inspectable property, carries this private brand at runtime.
  return Object.freeze({}) as PreparedPackageUpdate;
}

function createPackageExecutor<PreparedState>(
  implementation: PackageExecutorImplementation<PreparedState>,
): PackageUpdateExecutor {
  const preparedStates = new WeakMap<PreparedPackageUpdate, { value: PreparedState }>();
  const consumePrepared = (prepared: PreparedPackageUpdate): PreparedState => {
    const entry = preparedStates.get(prepared);
    if (!entry) {
      throw new UpdatePreMutationError(
        "package-update-preflight",
        "The prepared package update belongs to another executor or was already consumed.",
      );
    }
    preparedStates.delete(prepared);
    return entry.value;
  };

  return Object.freeze({
    async prepare(update) {
      const state = await implementation.prepare(update);
      const prepared = createPreparedPackageUpdate();
      preparedStates.set(prepared, { value: state });
      return prepared;
    },
    async activate({ prepared, activation }) {
      return implementation.activate({
        prepared: consumePrepared(prepared),
        activation,
      });
    },
    async discard(prepared, reason) {
      const state = consumePrepared(prepared);
      await implementation.discard?.(state, reason);
    },
  });
}

export function selectPackageExecutor(): PackageUpdateExecutor {
  return createPackageExecutor({
    async prepare(update) {
      // The compatibility executor prepares no artifacts. It only seals the
      // already-resolved plan before the service lifecycle can start mutating.
      return Object.freeze({ ...update });
    },
    async activate({ prepared, activation }) {
      return runPackageInstallUpdate({ ...prepared, ...activation });
    },
  });
}
