import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ManagedRepairBoundary } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import { managedRepairConfig } from "./update-managed-service-handoff-repair.test-support.js";
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";

export async function prepareManagedServiceRuntimeFixture(params: {
  recoveryModulePath: string;
  statePath: string;
  configPath: string;
  activationGatePath: string;
  activationReleasePath: string;
  ledger: boolean;
  options?: {
    replaceLedgerWriter?: boolean;
    requester?: { channel?: string; accountId?: string; senderId?: string };
    cancelAtActivation?: "requester" | "inspection";
    repair?: ManagedRepairBoundary;
  };
}) {
  const {
    recoveryModulePath,
    statePath,
    configPath,
    activationGatePath,
    activationReleasePath,
    ledger,
    options,
  } = params;
  // Source children run from the helper's durable cwd, outside this checkout.
  const sourceRuntimeImport = `
    const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});
    register({ tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
  `;
  const ledgerRuntimeImport = `
    ${sourceRuntimeImport}
    const ledger = await import(${JSON.stringify(new URL("./update-run-ledger.ts", import.meta.url).href)});
  `;
  if (ledger) {
    await fs.appendFile(
      recoveryModulePath,
      `
      ${ledgerRuntimeImport}
      export const { adoptUpdateRun, getUpdateRun, recordUpdateRunStep, recordUpdateRunVerification } = ledger;
      ${options?.replaceLedgerWriter ? 'export function finishUpdateRun() { throw new Error("the previous runtime must not finalize the candidate"); }' : "export const { finishUpdateRun } = ledger;"}
    `,
    );
  }
  if (options?.requester) {
    await fs.writeFile(statePath, "{}");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        options.repair
          ? managedRepairConfig(options.repair.baseUrl)
          : {
              commands: { ownerAllowFrom: ["slack:owner"] },
              channels: { slack: { enabled: true } },
            },
      ),
    );
    await fs.appendFile(
      recoveryModulePath,
      `
      export async function isManagedUpdateRequesterOwner(requester) {
        const state = ${managedServiceStateUpdateScript(
          statePath,
          `state.ownerChecked = true;
          ${options.cancelAtActivation === "requester" ? "state.ownerChecks = (state.ownerChecks || 0) + 1;" : ""}`,
        )};
        ${
          options.cancelAtActivation === "requester"
            ? `if (state.ownerChecks === 2) {
          fs.writeFileSync(${JSON.stringify(activationGatePath)}, "requester");
          while (!fs.existsSync(${JSON.stringify(activationReleasePath)})) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        return true;`
            : `const runtime = await import(${JSON.stringify(new URL("../../dist/cli/daemon-cli.js", import.meta.url).href)});
        return runtime.isManagedUpdateRequesterOwner(requester);`
        }
      }
    `,
    );
  }
  return { sourceRuntimeImport, ledgerRuntimeImport };
}
