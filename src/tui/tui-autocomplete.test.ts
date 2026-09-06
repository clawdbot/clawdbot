import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTuiAutocompleteProvider } from "./tui-autocomplete.js";

describe("createTuiAutocompleteProvider", () => {
  it("only scans ordinary paths after explicit completion", async () => {
    const provider = createTuiAutocompleteProvider([], process.cwd());
    const natural = provider.getSuggestions(["./src/"], 0, 6, {
      signal: new AbortController().signal,
    });

    await expect(natural).resolves.toBeNull();
    await expect(
      provider.getSuggestions(["./src/"], 0, 6, {
        force: true,
        signal: new AbortController().signal,
      }),
    ).resolves.not.toBeNull();
  });

  it("uses the provisioned file finder for attachment completion", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "openclaw-tui-autocomplete-"));
    const fdPath = join(fixture, "fd");
    await writeFile(fdPath, "#!/bin/sh\nprintf 'nested/needle.txt\\n'\n");
    await chmod(fdPath, 0o755);

    try {
      const provider = createTuiAutocompleteProvider([], fixture, fdPath);
      const suggestions = await provider.getSuggestions(["@needle"], 0, 7, {
        signal: new AbortController().signal,
      });

      expect(suggestions).toMatchObject({
        items: [{ label: "needle.txt", value: "@nested/needle.txt" }],
        prefix: "@needle",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("supports quoted attachment prefixes", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "openclaw-tui-autocomplete-"));
    const fdPath = join(fixture, "fd");
    await writeFile(fdPath, "#!/bin/sh\nprintf 'needle file.txt\\n'\n");
    await chmod(fdPath, 0o755);

    try {
      const provider = createTuiAutocompleteProvider([], fixture, fdPath);
      const suggestions = await provider.getSuggestions(['@"needle'], 0, 8, {
        signal: new AbortController().signal,
      });

      expect(suggestions?.items[0]?.value).toBe('@"needle file.txt"');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("omits terminal-unsafe paths while preserving safe Unicode paths", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "openclaw-tui-autocomplete-"));
    const fdPath = join(fixture, "fd");
    await writeFile(fdPath, "#!/bin/sh\nprintf 'raw\\033value.txt\\nمرحبا-東京.txt\\n'\n");
    await chmod(fdPath, 0o755);

    try {
      const provider = createTuiAutocompleteProvider([], fixture, fdPath);
      const suggestions = await provider.getSuggestions(["@"], 0, 1, {
        signal: new AbortController().signal,
      });

      expect(suggestions?.items).toEqual([
        {
          description: "\u2067مرحبا-東京.txt\u2069",
          label: "\u2067مرحبا-東京.txt\u2069",
          value: "@مرحبا-東京.txt",
        },
      ]);
      expect(provider.applyCompletion(["@"], 0, 1, suggestions!.items[0]!, "@")).toEqual({
        cursorCol: "@مرحبا-東京.txt ".length,
        cursorLine: 0,
        lines: ["@مرحبا-東京.txt "],
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
