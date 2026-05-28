import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigReloadLogScanner } from "../../scripts/e2e/lib/config-reload/log-scanner.mjs";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-config-reload-log-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("config reload log scanner", () => {
  it("keeps previous matches while reading only appended log lines", () => {
    const logPath = path.join(makeTempRoot(), "gateway.log");
    const scanner = createConfigReloadLogScanner(logPath, {
      maxReadBytes: 1024,
      tailLineLimit: 4,
    });

    expect(scanner.scan()).toEqual({ reloadLines: [], restartLines: [], tailLines: [] });

    writeFileSync(logPath, "gateway boot\n");
    expect(scanner.scan()).toEqual({
      reloadLines: [],
      restartLines: [],
      tailLines: ["gateway boot"],
    });

    appendFileSync(logPath, "config change detected; evaluating reload: plugins.entries.demo\n");
    expect(scanner.scan().reloadLines).toEqual([
      "config change detected; evaluating reload: plugins.entries.demo",
    ]);

    appendFileSync(logPath, "later noise\n");
    expect(scanner.scan().reloadLines).toEqual([
      "config change detected; evaluating reload: plugins.entries.demo",
    ]);
  });

  it("preserves partial lines between polls", () => {
    const logPath = path.join(makeTempRoot(), "gateway.log");
    const scanner = createConfigReloadLogScanner(logPath, {
      maxReadBytes: 1024,
      tailLineLimit: 4,
    });

    writeFileSync(logPath, "config change detected");
    expect(scanner.scan().reloadLines).toEqual([]);

    appendFileSync(logPath, "; evaluating reload: gateway.channelHealthCheckMinutes\n");
    expect(scanner.scan().reloadLines).toEqual([
      "config change detected; evaluating reload: gateway.channelHealthCheckMinutes",
    ]);
  });

  it("starts from a bounded tail of oversized logs", () => {
    const logPath = path.join(makeTempRoot(), "gateway.log");
    const reloadLine =
      "config change detected; evaluating reload: gateway.channelHealthCheckMinutes\n";
    writeFileSync(logPath, `${"x".repeat(4096)}\n${reloadLine}`);

    const scanner = createConfigReloadLogScanner(logPath, {
      maxReadBytes: reloadLine.length,
      tailLineLimit: 4,
    });

    expect(scanner.scan().reloadLines).toEqual([
      "config change detected; evaluating reload: gateway.channelHealthCheckMinutes",
    ]);
  });

  it("resets accumulated matches when the log rotates", () => {
    const logPath = path.join(makeTempRoot(), "gateway.log");
    const scanner = createConfigReloadLogScanner(logPath, {
      maxReadBytes: 1024,
      tailLineLimit: 4,
    });

    writeFileSync(logPath, "config change detected; evaluating reload: old.path\n");
    expect(scanner.scan().reloadLines).toEqual([
      "config change detected; evaluating reload: old.path",
    ]);

    writeFileSync(logPath, "config change requires gateway restart: new.path\n");
    const result = scanner.scan();
    expect(result.reloadLines).toEqual([]);
    expect(result.restartLines).toEqual(["config change requires gateway restart: new.path"]);
  });
});
