export type CodexSupervisorEndpoint =
  | {
      id: string;
      label?: string;
      transport: "stdio-proxy";
      command?: string;
      args?: string[];
      cwd?: string;
    }
  | {
      id: string;
      label?: string;
      transport: "websocket";
      url: string;
      authTokenEnv?: string;
    };

export type CodexSupervisorTurnMode = "auto" | "start" | "steer";

export type CodexSupervisorThreadStatus = string;

export type CodexSupervisorSession = {
  endpointId: string;
  threadId: string;
  sessionId?: string;
  cwd?: string;
  preview?: string;
  name?: string | null;
  source?: string;
  status: CodexSupervisorThreadStatus;
  updatedAt?: number;
  humanAttached?: boolean;
};

export type CodexSupervisorSendResult = {
  endpointId: string;
  threadId: string;
  mode: "start" | "steer";
  turnId?: string;
  status?: string;
};

export type CodexJsonRpcConnection = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  close(): Promise<void>;
};

export type CodexSupervisorEndpointHealth = {
  endpointId: string;
  ok: boolean;
  detail?: string;
};

export type CodexSupervisorSessionListResult = {
  sessions: CodexSupervisorSession[];
  errors: CodexSupervisorEndpointHealth[];
};
