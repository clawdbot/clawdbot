import { signalSetupWizard as signalSetupWizardImpl } from "./setup-surface.js";

type SignalSetupWizard = typeof import("./setup-surface.js").signalSetupWizard;

export const signalSetupWizard: SignalSetupWizard = { ...signalSetupWizardImpl };
