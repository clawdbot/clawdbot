import type { SecretInputMode } from "../../plugins/provider-auth-types.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

export type ChannelCredentialInputModePolicy = SecretInputMode | "per-credential";

export async function resolveSharedChannelCredentialInputMode(params: {
  prompter: Pick<WizardPrompter, "select">;
}): Promise<ChannelCredentialInputModePolicy> {
  const selected = await params.prompter.select<ChannelCredentialInputModePolicy>({
    message: "How do you want to provide these credentials?",
    initialValue: "plaintext",
    options: [
      {
        value: "plaintext",
        label: "Enter credentials",
        hint: "Stores the credentials directly in OpenClaw config",
      },
      {
        value: "ref",
        label: "Use external secret provider",
        hint: "Stores references to env or configured external secret providers",
      },
      {
        value: "per-credential",
        label: "Choose separately",
        hint: "Select a storage mode for each credential",
      },
    ],
  });
  return selected === "ref" || selected === "per-credential" ? selected : "plaintext";
}
