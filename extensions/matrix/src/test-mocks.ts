import type { Mock } from "vitest";
import { vi } from "vitest";

type MatrixBotSdkMockParams = {
  matrixClient?: unknown;
  simpleFsStorageProvider?: unknown;
  rustSdkCryptoStorageProvider?: unknown;
  includeVerboseLogService?: boolean;
};

type MatrixBotSdkMock = {
  ConsoleLogger: new () => {
    trace: Mock<() => void>;
    debug: Mock<() => void>;
    info: Mock<() => void>;
    warn: Mock<() => void>;
    error: Mock<() => void>;
  };
  MatrixClient: unknown;
  LogService: {
    setLogger: Mock<() => void>;
    warn?: Mock<() => void>;
    info?: Mock<() => void>;
    debug?: Mock<() => void>;
  };
  SimpleFsStorageProvider: unknown;
  RustSdkCryptoStorageProvider: unknown;
};

export function createMatrixBotSdkMock(params: MatrixBotSdkMockParams = {}): MatrixBotSdkMock {
  return {
    ConsoleLogger: class {
      trace = vi.fn();
      debug = vi.fn();
      info = vi.fn();
      warn = vi.fn();
      error = vi.fn();
    },
    MatrixClient: params.matrixClient ?? function MatrixClient() {},
    LogService: {
      setLogger: vi.fn(),
      ...(params.includeVerboseLogService
        ? {
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
          }
        : {}),
    },
    SimpleFsStorageProvider:
      params.simpleFsStorageProvider ?? function SimpleFsStorageProvider() {},
    RustSdkCryptoStorageProvider:
      params.rustSdkCryptoStorageProvider ?? function RustSdkCryptoStorageProvider() {},
  };
}
