import { describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";

function makeEaccesFs(configPath: string) {
  const eaccesErr = Object.assign(new Error(`EACCES: permission denied, open '${configPath}'`), {
    code: "EACCES",
  });
  return {
    existsSync: (p: string) => p === configPath,
    readFileSync: (p: string): string => {
      if (p === configPath) {
        throw eaccesErr;
      }
      throw new Error(`unexpected readFileSync: ${p}`);
    },
    promises: {
      readFile: () => Promise.reject(eaccesErr),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      appendFile: () => Promise.resolve(),
    },
  } as unknown as typeof import("node:fs");
}

describe("config io EACCES handling", () => {
  it("returns a helpful error message when config file is not readable (EACCES)", async () => {
    const configPath = "/data/.openclaw/openclaw.json";
    const errors: string[] = [];
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: {
        error: (msg: unknown) => errors.push(String(msg)),
        warn: () => {},
      },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0].message).toContain("EACCES");
    expect(snapshot.issues[0].message).toContain("chown");
    expect(snapshot.issues[0].message).toContain(configPath);
    // Should also emit to the logger
    expect(errors.join("\n")).toContain("chown");
  });

  it("includes configPath in the chown hint for the correct remediation command", async () => {
    const configPath = "/home/myuser/.openclaw/openclaw.json";
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.issues[0].message).toContain(configPath);
    expect(snapshot.issues[0].message).toContain("container");
  });
});
