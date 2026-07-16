import type { QaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import type { QaTransportAdapter } from "./qa-transport.js";

export type QaTransportId = "qa-channel";

export function normalizeQaTransportId(input?: string | null): QaTransportId {
  const transportId = input?.trim() || "qa-channel";
  switch (transportId) {
    case "qa-channel":
      return transportId;
    default:
      throw new Error(`unsupported QA transport: ${transportId}`);
  }
}

export function createQaTransportAdapter(params: {
  id: QaTransportId;
  state: QaBusState;
}): QaTransportAdapter {
  switch (params.id) {
    case "qa-channel":
      return createQaChannelTransport(params.state);
    default: {
      const unsupported: never = params.id;
      throw new Error(`unsupported QA transport: ${String(unsupported)}`);
    }
  }
}
