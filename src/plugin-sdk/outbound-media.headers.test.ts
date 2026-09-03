import { describe, expect, it } from "vitest";
import { buildHostedOutboundMediaResponseHeaders } from "./outbound-media.js";

describe("buildHostedOutboundMediaResponseHeaders", () => {
  it("creates download-only no-sniff headers with a sanitized UTF-8 filename", () => {
    const headers = buildHostedOutboundMediaResponseHeaders({
      byteLength: 123,
      contentType: "application/pdf; charset=binary",
      fileName: '../測試\r\nX-Evil: yes/"plan".pdf',
    });

    expect(headers).toMatchObject({
      "Content-Type": "application/pdf",
      "Content-Length": "123",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    expect(headers["Content-Disposition"]).toContain("attachment");
    expect(headers["Content-Disposition"]).toContain("filename*=UTF-8''");
    expect(headers["Content-Disposition"]).not.toMatch(/[\r\n]/u);
  });
});
