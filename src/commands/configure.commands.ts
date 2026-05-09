import { formatCliCommand } from "../cli/command-format.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import type { WizardSection } from "./configure.shared.js";
import { CONFIGURE_WIZARD_SECTIONS, parseConfigureWizardSections } from "./configure.shared.js";
import { runConfigureWizard } from "./configure.wizard.js";

async function configureCommand(runtime: RuntimeEnv = defaultRuntime) {
  await runConfigureWizard({ command: "configure" }, runtime);
}

async function configureCommandWithSections(
  sections: WizardSection[],
  runtime: RuntimeEnv = defaultRuntime,
) {
  await runConfigureWizard({ command: "configure", sections }, runtime);
}

export async function configureCommandFromSectionsArg(
  rawSections: unknown,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const { sections, invalid } = parseConfigureWizardSections(rawSections);
  if (sections.length === 0) {
    await configureCommand(runtime);
    return;
  }

  if (invalid.length > 0) {
    runtime.error(
      `Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}. Run ${formatCliCommand("openclaw configure")} without --section to use the full wizard.`,
    );
    runtime.exit(1);
    return;
  }

  await configureCommandWithSections(sections as never, runtime);
}
