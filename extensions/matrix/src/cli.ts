// Matrix plugin module implements cli behavior.
import type { Command } from "commander";
import { registerMatrixAccountCommands } from "./cli-account.js";
import { registerMatrixDeviceCommands } from "./cli-devices.js";
import { registerMatrixDirectCommands } from "./cli-direct.js";
import { registerMatrixEncryptionCommands } from "./cli-encryption.js";
import { registerMatrixProfileCommands } from "./cli-profile.js";
import { registerMatrixVerificationCommands } from "./cli-verification.js";

export function registerMatrixCli(params: { program: Command }): void {
  const root = params.program
    .command("matrix")
    .description("Matrix channel utilities")
    .addHelpText("after", () => "\nDocs: https://docs.openclaw.ai/channels/matrix\n");

  registerMatrixAccountCommands(root);
  registerMatrixProfileCommands(root);
  registerMatrixDirectCommands(root);
  registerMatrixEncryptionCommands(root);
  registerMatrixVerificationCommands(root);
  registerMatrixDeviceCommands(root);
}
