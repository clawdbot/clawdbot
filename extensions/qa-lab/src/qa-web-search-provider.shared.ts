// QA Lab web_search metadata shared by runtime and contract-only loading.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";

const QA_LAB_WEB_SEARCH_PROVIDER_ID = "qa-lab-search";
export const QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY = "OPENCLAW_QA_WEB_SEARCH_DENIED_INPUT";

export function createQaLabWebSearchProviderBase(): Omit<WebSearchProviderPlugin, "createTool"> {
  return {
    id: QA_LAB_WEB_SEARCH_PROVIDER_ID,
    label: "QA Lab Search",
    hint: "Deterministic QA-only web search fixture",
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://docs.openclaw.ai/concepts/qa-e2e-automation",
    docsUrl: "https://docs.openclaw.ai/concepts/qa-e2e-automation",
    credentialPath: "",
    inactiveSecretPaths: [],
    getCredentialValue: () => undefined,
    setCredentialValue: (searchConfigTarget, value) => {
      void searchConfigTarget;
      void value;
    },
  };
}
