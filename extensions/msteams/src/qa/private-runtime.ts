// Private QA runtime support for the Microsoft Teams live transport adapter.
import type { RequestConfig } from "@microsoft/teams.common";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";

const PRIVATE_QA_BUILD_ENV = "OPENCLAW_BUILD_PRIVATE_QA";
const PRIVATE_QA_NONCE_HEADER = "x-openclaw-msteams-qa-nonce";
const PRIVATE_QA_RUNTIME_SYMBOL = Symbol.for("openclaw.msteams.privateQaRuntime");

type PrivateQaEnv = Partial<Record<typeof PRIVATE_QA_BUILD_ENV, string>>;

type PrivateQaBootstrap = {
  connectorUrl?: string;
  nonce?: string;
  botToken?: string;
};

type HttpResponse<T = unknown> = {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: RequestConfig;
};

type PrivateQaHttpClientOptions = {
  headers?: Record<string, string>;
  token?: string | (() => string | Promise<string>);
};

class PrivateQaHttpClient {
  constructor(
    private readonly connectorUrl: string,
    private readonly nonce: string,
    private readonly options: PrivateQaHttpClientOptions = {},
  ) {}

  clone(options: PrivateQaHttpClientOptions = {}) {
    return new PrivateQaHttpClient(this.connectorUrl, this.nonce, {
      ...this.options,
      ...options,
      headers: { ...this.options.headers, ...options.headers },
    });
  }

  async request<T = unknown>(config: RequestConfig): Promise<HttpResponse<T>> {
    const sourceUrl = new URL(config.url ?? "", "https://smba.trafficmanager.net");
    const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, this.connectorUrl);
    const headers = new Headers(this.options.headers);
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      if (value != null) {
        headers.set(key, String(value));
      }
    }
    headers.set(PRIVATE_QA_NONCE_HEADER, this.nonce);
    const token =
      typeof this.options.token === "function" ? await this.options.token() : this.options.token;
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    const method = String(config.method ?? "GET").toUpperCase();
    const { response, release } = await fetchWithSsrFGuard({
      url: targetUrl.toString(),
      init: {
        method,
        headers,
        body:
          method === "GET" || method === "HEAD" || config.data == null
            ? undefined
            : typeof config.data === "string"
              ? config.data
              : JSON.stringify(config.data),
      },
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(targetUrl.toString()),
      maxRedirects: 0,
      auditContext: "msteams-private-qa-connector",
    });
    try {
      const text = await response.text();
      const data = text ? (JSON.parse(text) as T) : (undefined as T);
      if (!response.ok) {
        throw Object.assign(
          new Error(`Microsoft Teams private QA connector returned HTTP ${response.status}`),
          { statusCode: response.status },
        );
      }
      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        config,
      };
    } finally {
      await release();
    }
  }

  get<T = unknown>(url: string, config: RequestConfig = {}) {
    return this.request<T>({ ...config, method: "GET", url });
  }

  post<T = unknown>(url: string, data?: unknown, config: RequestConfig = {}) {
    return this.request<T>({ ...config, data, method: "POST", url });
  }

  put<T = unknown>(url: string, data?: unknown, config: RequestConfig = {}) {
    return this.request<T>({ ...config, data, method: "PUT", url });
  }

  patch<T = unknown>(url: string, data?: unknown, config: RequestConfig = {}) {
    return this.request<T>({ ...config, data, method: "PATCH", url });
  }

  delete<T = unknown>(url: string, config: RequestConfig = {}) {
    return this.request<T>({ ...config, method: "DELETE", url });
  }
}

type MSTeamsPrivateQaRuntime = {
  client: PrivateQaHttpClient;
  listenHost: "127.0.0.1";
  skipAuth: true;
  token: () => Promise<string>;
};

export function resolveMSTeamsPrivateQaRuntime(
  env: PrivateQaEnv = process.env,
  bootstrap: PrivateQaBootstrap | undefined = (
    globalThis as typeof globalThis & {
      [PRIVATE_QA_RUNTIME_SYMBOL]?: PrivateQaBootstrap;
    }
  )[PRIVATE_QA_RUNTIME_SYMBOL],
): MSTeamsPrivateQaRuntime | undefined {
  if (!bootstrap) {
    return undefined;
  }
  if (env[PRIVATE_QA_BUILD_ENV] !== "1") {
    throw new Error("Microsoft Teams private QA runtime requires OPENCLAW_BUILD_PRIVATE_QA=1");
  }
  const connectorUrl = bootstrap.connectorUrl?.trim();
  const nonce = bootstrap.nonce?.trim();
  const botToken = bootstrap.botToken?.trim();
  if (!connectorUrl || !nonce || !botToken) {
    throw new Error(
      "Microsoft Teams private QA bootstrap requires connector URL, nonce, and bot token",
    );
  }
  const parsedConnectorUrl = new URL(connectorUrl);
  if (
    parsedConnectorUrl.protocol !== "http:" ||
    (parsedConnectorUrl.hostname !== "127.0.0.1" && parsedConnectorUrl.hostname !== "localhost")
  ) {
    throw new Error("Microsoft Teams private QA connector must use loopback HTTP");
  }
  const client = new PrivateQaHttpClient(parsedConnectorUrl.toString(), nonce);
  return {
    client,
    listenHost: "127.0.0.1",
    skipAuth: true,
    token: async () => botToken,
  };
}
