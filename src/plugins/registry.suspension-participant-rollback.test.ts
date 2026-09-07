/** Verifies plugin-registered suspension participants follow the plugin lifecycle. */
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectGatewaySuspensionParticipants } from "../infra/gateway-suspension-participants.js";
import { resetGatewaySuspensionParticipantsForTest } from "../infra/gateway-suspension-participants.test-support.js";
import { createPluginRecord } from "./status.test-fixtures.js";

afterEach(() => {
  resetGatewaySuspensionParticipantsForTest();
});

describe("gateway suspension participant plugin lifecycle", () => {
  it("drops the participant when plugin registration rolls back", () => {
    const { config, registry } = createPluginRegistryFixture();
    const status = vi.fn(() => ({ activeCount: 3 }));
    const record = createPluginRecord({ id: "queue-plugin", name: "Queue Plugin" });

    expect(() =>
      registerTestPlugin({
        registry,
        config,
        record,
        register(api) {
          api.registerGatewaySuspensionParticipant({
            id: "delivery-queue",
            prepare: () => ({ activeCount: 3 }),
            status,
            resume: vi.fn(),
          });
          throw new Error("register failed");
        },
      }),
    ).toThrow("register failed");

    // Before rollback the process-global entry is live and blocking.
    expect(inspectGatewaySuspensionParticipants()).toEqual([
      { participantId: "queue-plugin:delivery-queue", count: 3, message: expect.any(String) },
    ]);

    registry.rollbackPluginGlobalSideEffects(record.id, record);

    // Registry rollback only splices registry-owned arrays, so this proves the
    // global registration is torn down too instead of stranding a dead callback.
    expect(inspectGatewaySuspensionParticipants()).toEqual([]);
    status.mockClear();
    expect(inspectGatewaySuspensionParticipants()).toEqual([]);
    expect(status).not.toHaveBeenCalled();
  });

  it("keeps a healthy plugin's participant registered", () => {
    const { config, registry } = createPluginRegistryFixture();
    const other = createPluginRecord({ id: "other-plugin", name: "Other Plugin" });
    const record = createPluginRecord({ id: "queue-plugin", name: "Queue Plugin" });

    registerTestPlugin({
      registry,
      config,
      record,
      register(api) {
        api.registerGatewaySuspensionParticipant({
          id: "delivery-queue",
          prepare: () => ({ activeCount: 2 }),
          status: () => ({ activeCount: 2 }),
          resume: vi.fn(),
        });
      },
    });

    // Rolling back an unrelated plugin must not disturb this registration.
    registry.rollbackPluginGlobalSideEffects(other.id, other);

    expect(inspectGatewaySuspensionParticipants()).toEqual([
      { participantId: "queue-plugin:delivery-queue", count: 2, message: expect.any(String) },
    ]);
  });
});
