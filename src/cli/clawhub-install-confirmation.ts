import { stdin, stdout } from "node:process";
import { promptYesNo } from "./prompt.js";

export function resolveClawHubInstallConfirmation(): (() => Promise<boolean>) | undefined {
  if (!stdin.isTTY || !stdout.isTTY) {
    return undefined;
  }
  return async () => await promptYesNo("Proceed with installation?");
}
