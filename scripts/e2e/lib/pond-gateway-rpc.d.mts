export type PondGatewayRpcOptions = {
  url: string;
  token: string;
  scopes: string[];
  openTimeoutMs?: number;
  webSocketFactory?: (target: string) => unknown;
};

export type PondGatewayRpcRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number;
};

export declare class PondGatewayRpc {
  constructor(options: PondGatewayRpcOptions);
  connect(): Promise<void>;
  request(
    method: string,
    params?: unknown,
    options?: PondGatewayRpcRequestOptions,
  ): Promise<unknown>;
  close(): void;
}
