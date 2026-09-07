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

  it("does not turn javascript or data URLs into anchors", () => {
    const container = renderLinked(
      "Ignore [xss](javascript:alert(1)) and [file](data:text/html,hi) please.",
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("[xss](javascript:alert(1))");
    expect(container.textContent).toContain("[file](data:text/html,hi)");
  });

  it("leaves ordinary notes unchanged", () => {
    const container = renderLinked("No links here, just triage notes.");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("No links here, just triage notes.");
  });
});
