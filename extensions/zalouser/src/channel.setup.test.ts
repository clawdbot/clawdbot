import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withEnvAsync } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createPluginSetupWizardStatus } from "../../../test/helpers/plugins/setup-wizard.js";
import "./zalo-js.test-mocks.js";
import { zalouserSetupPlugin } from "./setup-test-helpers.js";

const zalouserSetupGetStatus = createPluginSetupWizardStatus(zalouserSetupPlugin);

describe("zalouser setup plugin", () => {
  it("builds setup status without an initialized runtime", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-setup-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          zalouserSetupGetStatus({
            cfg: {},
            accountOverrides: {},
          }),
        ).resolves.toMatchObject({
          channel: "zalouser",
          configured: false,
          statusLines: ["Zalo Personal: needs QR login"],
        });
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
