import { WebSocket } from "ws";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";

const ARI_EVENT_MAX_BYTES = 256 * 1024;

export class AsteriskAriClient {
  readonly application: string;

  private readonly baseUrl: URL;
  private readonly apiHost: string;
  private readonly authorization: string;

  constructor(config: {
    baseUrl?: string;
    username?: string;
    password?: string;
    application?: string;
  }) {
    if (!config.baseUrl) {
      throw new Error("Asterisk ARI base URL is required");
    }
    if (!config.username) {
      throw new Error("Asterisk ARI username is required");
    }
    if (!config.password) {
      throw new Error("Asterisk ARI password is required");
    }

    const baseUrl = new URL(config.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error("Asterisk ARI base URL must use http or https");
    }
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error("Asterisk ARI base URL must not contain credentials, query, or fragment");
    }
    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/u, "") || "/ari";

    this.baseUrl = baseUrl;
    this.apiHost = baseUrl.hostname;
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    this.application = config.application ?? "openclaw";
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query?: Record<string, string>,
    allowNotFound = false,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl.pathname}${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return await guardedJsonApiRequest<T>({
      url: url.toString(),
      method,
      headers: {
        Authorization: this.authorization,
        "Content-Type": "application/json",
      },
      allowNotFound,
      allowedHostnames: [this.apiHost],
      auditContext: "voice-call.asterisk.ari",
      errorPrefix: "Asterisk ARI error",
    });
  }

  async deleteResource(path: string): Promise<void> {
    await this.request("DELETE", path, undefined, true);
  }

  createEventSocket(): WebSocket {
    const url = new URL(`${this.baseUrl.pathname}/events`, this.baseUrl);
    url.protocol = this.baseUrl.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("app", this.application);
    url.searchParams.set("subscribeAll", "false");
    return new WebSocket(url, {
      headers: { Authorization: this.authorization },
      maxPayload: ARI_EVENT_MAX_BYTES,
    });
  }
}
