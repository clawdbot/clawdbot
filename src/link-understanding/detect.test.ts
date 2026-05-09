import { describe, expect, it } from "vitest";
import { extractLinksFromMessage } from "./detect.js";

describe("extractLinksFromMessage", () => {
  it("extracts bare http/https URLs in order", () => {
    const links = extractLinksFromMessage("see https://a.example and http://b.test");
    expect(links).toEqual(["https://a.example", "http://b.test"]);
  });

  it("dedupes links and enforces maxLinks", () => {
    const links = extractLinksFromMessage("https://a.example https://a.example https://b.test", {
      maxLinks: 1,
    });
    expect(links).toEqual(["https://a.example"]);
  });

  it("ignores markdown links", () => {
    const links = extractLinksFromMessage("[doc](https://docs.example) https://bare.example");
    expect(links).toEqual(["https://bare.example"]);
  });

  it("blocks 127.0.0.1", () => {
    const links = extractLinksFromMessage("http://127.0.0.1/test https://ok.test");
    expect(links).toEqual(["https://ok.test"]);
  });

  it("blocks localhost and common loopback addresses", () => {
    expect(extractLinksFromMessage("http://localhost/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://localhost.localdomain/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://foo.localhost/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://service.local/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://service.internal/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://0.0.0.0/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://[::1]/secret")).toStrictEqual([]);
  });

  it("blocks private network ranges", () => {
    expect(extractLinksFromMessage("http://10.0.0.1/internal")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://172.16.0.1/internal")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://192.168.1.1/internal")).toStrictEqual([]);
  });

  it("blocks link-local and cloud metadata addresses", () => {
    expect(extractLinksFromMessage("http://169.254.169.254/latest/meta-data/")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://169.254.1.1/test")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://metadata.google.internal/computeMetadata/v1/")).toEqual(
      [],
    );
  });

  it("blocks CGNAT range used by Tailscale", () => {
    expect(extractLinksFromMessage("http://100.100.50.1/test")).toStrictEqual([]);
  });

  it("blocks private and mapped IPv6 addresses", () => {
    expect(extractLinksFromMessage("http://[::ffff:127.0.0.1]/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://[2001:db8:1234::5efe:127.0.0.1]/secret")).toStrictEqual(
      [],
    );
    expect(extractLinksFromMessage("http://[fe80::1]/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://[fc00::1]/secret")).toStrictEqual([]);
  });

  it("allows legitimate public URLs", () => {
    expect(extractLinksFromMessage("https://example.com/page")).toEqual([
      "https://example.com/page",
    ]);
    expect(extractLinksFromMessage("https://8.8.8.8/dns")).toEqual(["https://8.8.8.8/dns"]);
  });
});
