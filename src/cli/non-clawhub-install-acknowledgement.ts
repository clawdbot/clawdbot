import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  formatNonClawHubInstallWarning,
  NON_CLAWHUB_INSTALL_FORCE_FLAG,
  type NonClawHubInstallSourceClass,
} from "../plugins/install-provenance.js";
import type { RuntimeEnv } from "../runtime.js";
import { promptYesNo } from "./prompt.js";

export {
  NON_CLAWHUB_INSTALL_FORCE_FLAG,
  type NonClawHubInstallSourceClass,
} from "../plugins/install-provenance.js";

function canPromptForNonClawHubInstall(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export async function confirmNonClawHubInstall(params: {
  acknowledged?: boolean;
  runtime: RuntimeEnv;
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
}): Promise<boolean> {
  const warning = formatNonClawHubInstallWarning({
    sourceClass: params.sourceClass,
    spec: params.spec,
  });
  if (params.acknowledged) {
    params.runtime.log(theme.warn(warning));
    return true;
  }
  if (canPromptForNonClawHubInstall()) {
    params.runtime.log(theme.warn(warning));
    return await promptYesNo("Install this non-ClawHub plugin source?");
  }
  params.runtime.error(
    `${warning}\nInstall cancelled; rerun with ${NON_CLAWHUB_INSTALL_FORCE_FLAG} after reviewing the source.`,
  );
  return false;
}
