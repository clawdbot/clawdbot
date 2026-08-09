// Resolves provider authentication modes for plugin setup prompts.
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./provider-auth-types.js";

/** Prompt copy overrides for provider secret input mode selection. */
type SecretInputModePromptCopy = {
  modeMessage?: string;
  plaintextLabel?: string;
  plaintextHint?: string;
  refLabel?: string;
  refHint?: string;
};

/** Resolves provider secret input mode from explicit option or wizard selection. */
export async function resolveSecretInputModeForEnvSelection(params: {
  prompter: Pick<WizardPrompter, "select">;
  explicitMode?: SecretInputMode;
  copy?: SecretInputModePromptCopy;
}): Promise<SecretInputMode> {
  if (params.explicitMode) {
    return params.explicitMode;
  }
  if (typeof params.prompter.select !== "function") {
    return "plaintext";
  }
  const selected = await params.prompter.select<SecretInputMode>({
    message: params.copy?.modeMessage ?? "How do you want to provide this API key?",
    initialValue: "plaintext",
    options: [
      {
        value: "plaintext",
        label: params.copy?.plaintextLabel ?? "Paste API key now",
        hint: params.copy?.plaintextHint ?? "Stores the key directly in OpenClaw config",
      },
      {
        value: "ref",
        label: params.copy?.refLabel ?? "Use external secret provider",
        hint:
          params.copy?.refHint ??
          "Stores a reference to env or configured external secret providers",
      },
    ],
  });
  return selected === "ref" ? "ref" : "plaintext";
}
