/** Minimal Gateway request surface consumed by the reusable node-host runtime. */
import type { GatewayClientRequestOptions } from "../gateway/client.js";

export type NodeHostClient = {
  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T>;
};
