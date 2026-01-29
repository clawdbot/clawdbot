import { describe, expect, it } from "vitest";

import { fetchRemoteMedia, _isUrlAllowed } from "./fetch.js";

function makeStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("fetchRemoteMedia", () => {
  it("rejects when content-length exceeds maxBytes", async () => {
    const fetchImpl = async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3, 4, 5])]), {
        status: 200,
        headers: { "content-length": "5" },
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("rejects when streamed payload exceeds maxBytes", async () => {
    const fetchImpl = async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]), {
        status: 200,
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("blocks localhost URLs", async () => {
    await expect(fetchRemoteMedia({ url: "http://localhost:8080/file" })).rejects.toThrow(
      "URL not allowed",
    );

    await expect(fetchRemoteMedia({ url: "http://localhost/file" })).rejects.toThrow(
      "URL not allowed",
    );
  });

  it("blocks private IP ranges", async () => {
    // 10.x.x.x
    await expect(fetchRemoteMedia({ url: "http://10.0.0.1/file" })).rejects.toThrow(
      "URL not allowed",
    );
    // 172.16.x.x - 172.31.x.x
    await expect(fetchRemoteMedia({ url: "http://172.16.0.1/file" })).rejects.toThrow(
      "URL not allowed",
    );
    // 192.168.x.x
    await expect(fetchRemoteMedia({ url: "http://192.168.1.1/file" })).rejects.toThrow(
      "URL not allowed",
    );
  });

  it("blocks loopback addresses", async () => {
    await expect(fetchRemoteMedia({ url: "http://127.0.0.1/file" })).rejects.toThrow(
      "URL not allowed",
    );
    await expect(fetchRemoteMedia({ url: "http://127.0.0.5/file" })).rejects.toThrow(
      "URL not allowed",
    );
  });

  it("blocks IPv6 loopback", async () => {
    await expect(fetchRemoteMedia({ url: "http://[::1]/file" })).rejects.toThrow("URL not allowed");
  });

  it("blocks link-local addresses (AWS metadata)", async () => {
    await expect(
      fetchRemoteMedia({ url: "http://169.254.169.254/latest/meta-data/" }),
    ).rejects.toThrow("URL not allowed");
  });

  it("blocks redirects to private IPs", async () => {
    const fetchImpl = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      });

    await expect(
      fetchRemoteMedia({ url: "https://example.com/redirect", fetchImpl }),
    ).rejects.toThrow("Redirect blocked");
  });

  it("limits redirect count", async () => {
    let redirectCount = 0;
    const fetchImpl = async () => {
      redirectCount++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.com/redirect${redirectCount}` },
      });
    };

    await expect(fetchRemoteMedia({ url: "https://example.com/start", fetchImpl })).rejects.toThrow(
      "Too many redirects",
    );
  });
});

describe("isUrlAllowed (SSRF protection)", () => {
  it("allows valid external URLs", () => {
    expect(_isUrlAllowed("https://example.com/file.jpg")).toBe(true);
    expect(_isUrlAllowed("http://cdn.example.org/image.png")).toBe(true);
    expect(_isUrlAllowed("https://8.8.8.8/file")).toBe(true);
  });

  it("blocks non-http protocols", () => {
    expect(_isUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(_isUrlAllowed("ftp://example.com/file")).toBe(false);
    expect(_isUrlAllowed("data:text/plain,hello")).toBe(false);
  });

  it("blocks localhost variations", () => {
    expect(_isUrlAllowed("http://localhost/file")).toBe(false);
    expect(_isUrlAllowed("http://localhost:3000/api")).toBe(false);
    expect(_isUrlAllowed("http://sub.localhost/file")).toBe(false);
  });

  it("blocks loopback IPs", () => {
    expect(_isUrlAllowed("http://127.0.0.1/file")).toBe(false);
    expect(_isUrlAllowed("http://127.0.0.255/file")).toBe(false);
    expect(_isUrlAllowed("http://[::1]/file")).toBe(false);
  });

  it("blocks private IP ranges", () => {
    // Class A private
    expect(_isUrlAllowed("http://10.0.0.1/file")).toBe(false);
    expect(_isUrlAllowed("http://10.255.255.255/file")).toBe(false);
    // Class B private
    expect(_isUrlAllowed("http://172.16.0.1/file")).toBe(false);
    expect(_isUrlAllowed("http://172.31.255.255/file")).toBe(false);
    // Class C private
    expect(_isUrlAllowed("http://192.168.0.1/file")).toBe(false);
    expect(_isUrlAllowed("http://192.168.255.255/file")).toBe(false);
  });

  it("blocks link-local addresses", () => {
    expect(_isUrlAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(_isUrlAllowed("http://169.254.0.1/file")).toBe(false);
  });

  it("blocks unspecified addresses", () => {
    expect(_isUrlAllowed("http://0.0.0.0/file")).toBe(false);
    expect(_isUrlAllowed("http://[::]/file")).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(_isUrlAllowed("not-a-url")).toBe(false);
    expect(_isUrlAllowed("")).toBe(false);
  });
});
