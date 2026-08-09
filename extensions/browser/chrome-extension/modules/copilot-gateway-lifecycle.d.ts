type StorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(update: Record<string, unknown>): Promise<void>;
};

type CopilotIdentity = {
  deviceId: string;
  publicKey: string;
  sign(payload: string): Promise<string>;
};

type TokenParams = {
  clientId: string;
  deviceId: string;
  role: string;
};

type StoredToken = {
  token: string;
  scopes: string[];
};

export function loadOrCreateCopilotIdentity(
  storage: StorageArea,
  gatewayScope: string,
): Promise<CopilotIdentity>;

export function createCopilotTokenStore(
  storage: StorageArea,
  gatewayScope: string,
): {
  load: (params: TokenParams) => Promise<StoredToken | null>;
  store: (params: TokenParams & StoredToken) => Promise<void>;
  clear: (params: TokenParams) => Promise<void>;
};

export function resolveCopilotClose(context: {
  connectFailure?: {
    error?: {
      details?: { code?: string; pauseReconnect?: boolean };
    };
  };
}): {
  retry: boolean;
  notify: boolean;
  pendingError: unknown;
};
