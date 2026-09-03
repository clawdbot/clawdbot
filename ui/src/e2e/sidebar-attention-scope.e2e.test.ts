// Control UI browser proof covers selected-agent and all-agent Inbox automation scope.
import path from "node:path";
import { it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { runSidebarAttentionScopeFlow } from "./sidebar-attention-scope.e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Inbox automation scope",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("scopes automation attention and bulk dismissal across agents", async () => {
    await runSidebarAttentionScopeFlow({
      get artifactDir() {
        return path.join(suite.artifactDir, "inbox-agent-scope");
      },
      baseUrl: suite.server.baseUrl,
      browser: suite.browser,
      captureProof: false,
    });
  });
});
