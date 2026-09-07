// Environment docs tests validate documented environment variable references.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readDoc(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

const providerCredentialExamples = [
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "BRAVE_API_KEY",
] as const;

describe("environment docs", () => {
  it("documents the trusted sources for provider credentials", async () => {
    const markdown = await readDoc("docs/help/environment.md");

    expect(markdown).toContain("Provider credentials and workspace `.env`");
    expect(markdown).toContain(
      "OpenClaw ignores provider credentials and protected runtime controls from workspace `.env`",
    );
    expect(markdown).toContain("~/.openclaw/.env");
    expect(markdown).toContain("$OPENCLAW_STATE_DIR/.env");
    expect(markdown).toContain("The config `env` block");
    expect(markdown).toContain("OPENCLAW_LOAD_SHELL_ENV=1");

    for (const key of providerCredentialExamples) {
      expect(markdown).toContain(key);
    }
  });

  it("keeps the security guide aligned with the workspace dotenv credential boundary", async () => {
    const markdown = await readDoc("docs/gateway/security/index.md");

    expect(markdown).toContain(
      "Provider credential environment variables are blocked from untrusted workspace `.env` files",
    );
    expect(markdown).toContain("provider auth keys declared by installed trusted plugins");
    expect(markdown).toContain("~/.openclaw/.env");
    expect(markdown).toContain("$OPENCLAW_STATE_DIR/.env");

    for (const key of providerCredentialExamples) {
      expect(markdown).toContain(key);
    }
  });
});
