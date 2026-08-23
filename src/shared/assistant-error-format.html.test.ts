import { describe, expect, it } from "vitest";
import { isCloudflareOrHtmlErrorPage } from "./assistant-error-format.js";

describe("isCloudflareOrHtmlErrorPage", () => {
  it("detects Cloudflare 521 HTML pages", () => {
    const htmlError = `521 <!DOCTYPE html>
<html lang="en-US">
  <head><title>Web server is down | example.com | Cloudflare</title></head>
  <body><h1>Web server is down</h1></body>
</html>`;

    expect(isCloudflareOrHtmlErrorPage(htmlError)).toBe(true);
  });

  it("detects generic 5xx HTML pages", () => {
    const htmlError = `503 <html><head><title>Service Unavailable</title></head><body>down</body></html>`;
    expect(isCloudflareOrHtmlErrorPage(htmlError)).toBe(true);
  });

  it("detects standalone Cloudflare challenge HTML pages", () => {
    // HTML challenge pages are provider transport failures, not model text.
    const htmlError = `<!DOCTYPE html>
<html lang="en-US">
  <head><title>Just a moment...</title></head>
  <body>
    <span id="challenge-error-text">Enable JavaScript and cookies to continue</span>
    <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
  </body>
</html>`;
    expect(isCloudflareOrHtmlErrorPage(htmlError)).toBe(true);
  });

  it("does not flag non-HTML status lines", () => {
    expect(isCloudflareOrHtmlErrorPage("500 Internal Server Error")).toBe(false);
    expect(isCloudflareOrHtmlErrorPage("429 Too Many Requests")).toBe(false);
  });

  it("does not flag quoted HTML without a closing html tag", () => {
    const plainTextWithHtmlPrefix = "500 <!DOCTYPE html> upstream responded with partial HTML text";
    expect(isCloudflareOrHtmlErrorPage(plainTextWithHtmlPrefix)).toBe(false);
  });
});
