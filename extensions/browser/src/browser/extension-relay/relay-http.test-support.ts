import net from "node:net";

type RawResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export class RawHttpConnection {
  private buffer = Buffer.alloc(0);
  private readonly waiters: Array<() => void> = [];

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    this.waiters.splice(0).forEach((resolve) => resolve());
  };

  private constructor(readonly socket: net.Socket) {
    socket.on("data", this.onData);
  }

  takeSocket(): net.Socket {
    if (this.buffer.length) {
      throw new Error("Unexpected bytes before WebSocket upgrade");
    }
    this.socket.off("data", this.onData);
    return this.socket;
  }

  static async connect(port: number): Promise<RawHttpConnection> {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new RawHttpConnection(socket);
  }

  async request(
    method: string,
    requestPath: string,
    body = "",
    headers: Record<string, string> = {},
  ): Promise<RawResponse> {
    this.socket.write(
      [
        `${method} ${requestPath} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: keep-alive",
        `Content-Length: ${Buffer.byteLength(body)}`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        "",
        body,
      ].join("\r\n"),
    );
    return await this.readResponse();
  }

  async upgrade(requestPath: string): Promise<RawResponse> {
    this.socket.write(
      [
        `GET ${requestPath} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
    return await this.readResponse({ headersOnly: true });
  }

  private async waitForData(): Promise<void> {
    if (this.socket.destroyed) {
      throw new Error("socket closed before response completed");
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private async readResponse(options: { headersOnly?: boolean } = {}): Promise<RawResponse> {
    let headerEnd = this.buffer.indexOf("\r\n\r\n");
    while (headerEnd < 0) {
      await this.waitForData();
      headerEnd = this.buffer.indexOf("\r\n\r\n");
    }
    const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
    const [statusLine, ...headerLines] = headerText.split("\r\n");
    const headers = Object.fromEntries(
      headerLines.map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
      }),
    );
    const contentLength = options.headersOnly ? 0 : Number(headers["content-length"] ?? 0);
    const responseLength = headerEnd + 4 + contentLength;
    while (this.buffer.length < responseLength) {
      await this.waitForData();
    }
    const body = this.buffer.subarray(headerEnd + 4, responseLength).toString("utf8");
    this.buffer = this.buffer.subarray(responseLength);
    return {
      status: Number(/^HTTP\/1\.1 (\d+)/u.exec(statusLine ?? "")?.[1] ?? 0),
      headers,
      body,
    };
  }

  close(): void {
    this.socket.destroy();
  }
}
