import { describe, expect, it, vi } from "vitest";
import { CONTROL_MODEL_CATALOG_REFRESH_CONFORMANCE_FIXTURES } from "./conformance-fixtures.js";
import {
  createControlModelCatalog,
  type ControlModelGatewayBinding,
  type ControlModelGatewayEventFrame,
} from "./index.js";

describe("Control Model shared conformance fixtures", () => {
  for (const fixture of CONTROL_MODEL_CATALOG_REFRESH_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const eventListeners = new Set<(frame: ControlModelGatewayEventFrame) => void>();
      const gateway: ControlModelGatewayBinding = {
        getConnectionSnapshot: () => ({ status: "connected", epoch: 1 }),
        subscribeConnection: () => () => undefined,
        subscribeSessionCatalogInvalidations: () => () => undefined,
        subscribeEvents(listener) {
          eventListeners.add(listener);
          return () => eventListeners.delete(listener);
        },
        request: vi.fn(async () => fixture.response as never),
      };
      const model = createControlModelCatalog({ gateway });

      model.start();
      await vi.waitFor(() => {
        expect(model.getSnapshot().sessionCatalog.status).toBe(fixture.expected.status);
      });

      const snapshot = model.getSnapshot().sessionCatalog;
      expect(snapshot.sessions.map((session) => session.key)).toEqual(fixture.expected.sessionKeys);
      expect(snapshot.error?.code ?? null).toBe(fixture.expected.errorCode);
      model.dispose();
    });
  }
});
