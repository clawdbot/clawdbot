// Installs channel plugin fixtures for heartbeat runner tests.
import { beforeEach } from "vitest";
import {
  heartbeatRunnerSlackPlugin,
  heartbeatRunnerTelegramPlugin,
  heartbeatRunnerWhatsAppPlugin,
} from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

// Heartbeat runner tests install lightweight channel plugin facades so delivery
// behavior can be verified without real channel credentials.
/** Install the heartbeat runner channel registry before each test. */
export function installHeartbeatRunnerTestRuntime(params?: { includeSlack?: boolean }): void {
  beforeEach(() => {
    if (params?.includeSlack) {
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "slack", plugin: heartbeatRunnerSlackPlugin, source: "test" },
          { pluginId: "whatsapp", plugin: heartbeatRunnerWhatsAppPlugin, source: "test" },
          { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
        ]),
      );
      return;
    }
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "whatsapp", plugin: heartbeatRunnerWhatsAppPlugin, source: "test" },
        { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
      ]),
    );
  });
}
