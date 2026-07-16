import { beforeEach, vi } from "vitest";
import {
  type AsyncMock,
  loadConfigMock,
  readAllowFromStoreMock,
  resetPairingSecurityMocks,
  upsertPairingRequestMock,
} from "../pairing-security.test-harness.js";

export const sendMessageMock = vi.fn() as AsyncMock;
export { readAllowFromStoreMock, upsertPairingRequestMock };

let config: Record<string, unknown> = {};

export function setAccessControlTestConfig(next: Record<string, unknown>): void {
  config = next;
  loadConfigMock.mockReturnValue(config);
}

export function setupAccessControlTestHarness(): void {
  beforeEach(() => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    };
    sendMessageMock.mockReset().mockResolvedValue(undefined);
    resetPairingSecurityMocks(config);
  });
}
