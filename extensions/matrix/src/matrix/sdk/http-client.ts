import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import type { SsrFPolicy } from "../../runtime-api.js";
import { buildHttpError } from "./event-helpers.js";
import { type HttpMethod, type QueryParams, performMatrixRequest } from "./transport.js";

type MatrixAuthedHttpClientParams = {
  homeserver: string;
  accessToken: string;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
};

export class MatrixAuthedHttpClient {
  private readonly homeserver: string;
  private readonly accessToken: string;
  private readonly ssrfPolicy?: SsrFPolicy;
  private readonly dispatcherPolicy?: PinnedDispatcherPolicy;

  constructor(params: MatrixAuthedHttpClientParams) {
    this.homeserver = params.homeserver;
    this.accessToken = params.accessToken;
    this.ssrfPolicy = params.ssrfPolicy;
    this.dispatcherPolicy = params.dispatcherPolicy;
  }

  async requestJson(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    body?: unknown;
    timeoutMs: number;
    allowAbsoluteEndpoint?: boolean;
  }): Promise<unknown> {
    const { response, text } = await performMatrixRequest({
      homeserver: this.homeserver,
      accessToken: this.accessToken,
      method: params.method,
      endpoint: params.endpoint,
      qs: params.qs,
      body: params.body,
      timeoutMs: params.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
      dispatcherPolicy: this.dispatcherPolicy,
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, text);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      if (!text.trim()) {
        return {};
      }
      return JSON.parse(text);
    }
    return text;
  }

  async requestRaw(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    timeoutMs: number;
    maxBytes?: number;
    readIdleTimeoutMs?: number;
    allowAbsoluteEndpoint?: boolean;
  }): Promise<Buffer> {
    const { response, buffer } = await performMatrixRequest({
      homeserver: this.homeserver,
      accessToken: this.accessToken,
      method: params.method,
      endpoint: params.endpoint,
      qs: params.qs,
      timeoutMs: params.timeoutMs,
      raw: true,
      maxBytes: params.maxBytes,
      readIdleTimeoutMs: params.readIdleTimeoutMs,
      ssrfPolicy: this.ssrfPolicy,
      dispatcherPolicy: this.dispatcherPolicy,
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, buffer.toString("utf8"));
    }
    return buffer;
  }
}
