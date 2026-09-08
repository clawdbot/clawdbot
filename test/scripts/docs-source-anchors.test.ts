import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocsDocument, resolveDocsFragment } from "../../scripts/lib/docs-markdown.mjs";

const docsRoot = path.resolve(import.meta.dirname, "../../docs");

function readDocument(file: string) {
  return parseDocsDocument(fs.readFileSync(path.join(docsRoot, file), "utf8"));
}

describe("authored docs section links", () => {
  it("links Codex Computer Use to the Windows and Linux fulfiller section", () => {
    const source = readDocument("plugins/codex-computer-use.md");
    const target = readDocument("nodes/computer-use.md");
    const links = source.links.filter((href: string) => href.startsWith("/nodes/computer-use#"));
    expect(links).toHaveLength(1);

    const heading = target.tokens.find(
      (token, index) =>
        token.type === "heading_open" &&
        target.tokens[index + 1]?.content === "Windows and Linux (experimental, direct SDK)",
    );
    expect(heading).toBeDefined();
    const headingIds = [heading?.attrGet("id"), heading?.meta?.anchorAlias].filter(
      (id): id is string => typeof id === "string",
    );
    expect(headingIds).not.toHaveLength(0);
    expect(headingIds).toContain(resolveDocsFragment(links[0].split("#")[1], new Set(target.ids)));
  });

  it("keeps the Podman and Tailscale jump target unique and collision-free", () => {
    const document = readDocument("install/podman.md");
    expect(document.links).toContain("#podman-and-tailscale");
    expect(document.ids.filter((id: string) => id === "podman-and-tailscale")).toHaveLength(1);
    expect(document.collisions).toEqual([]);
  });
});
