// Per-file setup leases the shard-scoped production bundle through the test helper.
import { inject } from "vitest";
import { setSharedControlUiE2eServerBaseUrl } from "../../ui/src/test-helpers/control-ui-e2e.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eServerBaseUrl: string | null;
  }
}

const serverBaseUrl = inject("controlUiE2eServerBaseUrl");
if (serverBaseUrl) {
  setSharedControlUiE2eServerBaseUrl(serverBaseUrl);
}
