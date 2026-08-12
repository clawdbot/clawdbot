type NativeMessagePort = {
  disconnect(): void;
  onDisconnect: { addListener(listener: () => void): void };
  onMessage: { addListener(listener: (response: unknown) => void): void };
  postMessage(request: unknown): void;
};

type NativeBootstrapStorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

type NativeBootstrapResult = {
  status:
    | "disabled"
    | "enabled"
    | "existing"
    | "manual_required"
    | "paired"
    | "retrying"
    | "superseded";
  code?: string;
};

export function createNativeBootstrapController(params: {
  chromeApi?: {
    runtime: {
      connectNative(name: string): NativeMessagePort;
      lastError?: { message?: string };
    };
    storage: { local: NativeBootstrapStorageArea };
  };
  getPairing(): Promise<{ relayUrl?: string } | null>;
  applyPairing(params: {
    pairing: { relayUrl: string; token: string; gatewayUrl?: string };
    accessMode: "all";
    source: "native";
    generation: number;
  }): Promise<{ ok?: boolean; existing?: boolean } | undefined>;
}): {
  attempt(): Promise<NativeBootstrapResult>;
  disableSynchronously(): Promise<void>;
  enable(options?: { attemptNow?: boolean }): Promise<NativeBootstrapResult>;
  status(): Promise<{ disabled: boolean; state: string; failureCode?: string }>;
};

type RetiredCopilotStorage = {
  storage: {
    local: Pick<NativeBootstrapStorageArea, "get" | "set" | "remove">;
    session: Pick<NativeBootstrapStorageArea, "remove">;
  };
};

export function prepareRetiredCopilotState(
  chromeApi?: RetiredCopilotStorage,
): Promise<{ blocked: boolean }>;

export function discardRetiredCopilotState(chromeApi?: RetiredCopilotStorage): Promise<void>;
