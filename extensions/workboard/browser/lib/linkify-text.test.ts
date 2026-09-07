import "../test/dom.setup.ts";
import { html, render } from "lit";
import { describe, expect, it } from "vitest";
import { renderLinkedPlainText } from "./linkify-text.ts";

function renderLinked(text: string): HTMLElement {
  const container = document.createElement("div");
  render(html`<p>${renderLinkedPlainText(text)}</p>`, container);
  return container;
}

describe("renderLinkedPlainText", () => {
  it("turns markdown links and bare https URLs into external anchors", () => {
    const container = renderLinked("See [Anrop](https://anrop.no/) and https://www.smuv.no/.");
    const links = [...container.querySelectorAll("a")];
    expect(links).toHaveLength(2);
    expect(links[0]?.textContent).toBe("Anrop");
    expect(links[0]?.getAttribute("href")).toBe("https://anrop.no/");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[1]?.textContent).toBe("https://www.smuv.no/");
    expect(links[1]?.getAttribute("href")).toBe("https://www.smuv.no/");
    expect(container.textContent).toBe("See Anrop and https://www.smuv.no/.");
  });

  it("keeps surrounding punctuation on autolinked URLs", () => {
    const container = renderLinked("Open https://example.com/docs.");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(container.textContent).toBe("Open https://example.com/docs.");
  });

  it("keeps wrapping parentheses around a bare URL", () => {
    const container = renderLinked("See (https://example.com)");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(container.textContent).toBe("See (https://example.com)");
  });

  it("links http markdown and localhost URLs", () => {
    const container = renderLinked("Try [local](http://127.0.0.1:8080/status) today.");
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("local");
    expect(link?.getAttribute("href")).toBe("http://127.0.0.1:8080/status");
  });

  it("still autolinks a URL inside malformed markdown", () => {
    const container = renderLinked("Broken [docs](https://example.com still text.");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(container.textContent).toBe("Broken [docs](https://example.com still text.");
  });

  it("does not turn javascript or data URLs into anchors", () => {
    const container = renderLinked(
      "Ignore [xss](javascript:alert(1)) and [file](data:text/html,hi) please.",
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("[xss](javascript:alert(1))");
    expect(container.textContent).toContain("[file](data:text/html,hi)");
  });

  it.each([
    ["ftp markdown", "See [files](ftp://files.example/doc) first."],
    ["mailto markdown", "Email [us](mailto:hi@example.com) maybe."],
    ["non-url markdown", "Broken [docs](not-a-url) still text."],
    ["empty host", "Skip [bad](https://) entirely."],
    ["www without scheme", "Visit www.example.com later."],
    ["bold markdown", "Keep **bold** and `code` literal."],
  ])("leaves %s unchanged", (_name, text) => {
    const container = renderLinked(text);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it("leaves ordinary notes unchanged", () => {
    const container = renderLinked("No links here, just triage notes.");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("No links here, just triage notes.");
  });
});
