// Cloud secret install docs tests validate documented cloud secret setup.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const INSTALL_DOCS_DIR = path.join(process.cwd(), "docs", "install");
const CLOUD_DOCKER_VM_INSTALL_DOCS = new Set(["gcp.md", "hetzner.md"]);
const KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS = [
  "change-me-to-a-long-random-token",
  "change-me-now",
] as const;
const KNOWN_WEAK_GATEWAY_PASSWORD_PLACEHOLDERS = ["change-me-to-a-strong-password"] as const;

async function readInstallDocs(): Promise<Array<{ docName: string; markdown: string }>> {
  const entries = await fs.readdir(INSTALL_DOCS_DIR, { withFileTypes: true });
  return await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => ({
        docName: entry.name,
        markdown: await fs.readFile(path.join(INSTALL_DOCS_DIR, entry.name), "utf8"),
      })),
  );
}

describe("cloud install docs", () => {
  it("does not publish a copy-paste gateway token placeholder", async () => {
    for (const { docName, markdown } of await readInstallDocs()) {
      for (const token of KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS) {
        expect(markdown, docName).not.toContain(`OPENCLAW_GATEWAY_TOKEN=${token}`);
      }
      for (const password of KNOWN_WEAK_GATEWAY_PASSWORD_PLACEHOLDERS) {
        expect(markdown, docName).not.toContain(`OPENCLAW_GATEWAY_PASSWORD=${password}`);
      }
      expect(markdown, docName).not.toMatch(/^ {4}GOG_KEYRING_PASSWORD=change-me-now$/m);
      if (CLOUD_DOCKER_VM_INSTALL_DOCS.has(docName)) {
        expect(markdown, docName).toMatch(/^ {4}OPENCLAW_GATEWAY_TOKEN=[ \t]*\r?$/m);
        expect(markdown, docName).toMatch(/^ {4}GOG_KEYRING_PASSWORD=[ \t]*\r?$/m);
        expect(markdown, docName).toContain("openssl rand -hex 32");
      }
    }
  });
});
