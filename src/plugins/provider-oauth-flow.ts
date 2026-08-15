/** Coordinates provider OAuth flows exposed by plugin-owned auth integrations. */
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Prompt payload used when OAuth flow code entry needs user input. */
type OAuthPrompt = { message: string; placeholder?: string };

const validateRequiredInput = (value: string) => (value.trim().length > 0 ? undefined : "Required");

/** Creates OAuth callbacks that use local browser auth locally and manual code entry on VPS hosts. */
export function createVpsAwareOAuthHandlers(params: {
  isRemote: boolean;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  spin: ReturnType<WizardPrompter["progress"]>;
  openUrl: (url: string) => Promise<unknown>;
  localBrowserMessage: string;
  manualPromptMessage?: string;
  manualPromptSignal?: AbortSignal;
}): {
  onAuth: (event: { url: string }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
} {
  const manualPromptMessage = params.manualPromptMessage ?? "Paste the redirect URL";
  // Remote hosts cannot open the user's browser, so auth starts in onAuth and finishes in onPrompt.
  let manualCodePromise: Promise<string> | undefined;

  return {
    onAuth: async ({ url }) => {
      if (params.isRemote) {
        params.spin.stop("OAuth URL ready");
        params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
        await params.openUrl(url);
        await params.prompter.note(
          `Open this URL in your LOCAL browser:\n\n${url}`,
          "OAuth sign-in",
        );
        manualCodePromise = params.prompter.text({
          message: manualPromptMessage,
          signal: params.manualPromptSignal,
          validate: validateRequiredInput,
        });
        return;
      }

      params.spin.update(params.localBrowserMessage);
      await params.openUrl(url);
      params.runtime.log(`Open: ${url}`);
    },
    onPrompt: async (prompt) => {
      if (manualCodePromise) {
        return manualCodePromise;
      }
      const code = await params.prompter.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        signal: params.manualPromptSignal,
        validate: validateRequiredInput,
      });
      return code;
    },
  };
}
