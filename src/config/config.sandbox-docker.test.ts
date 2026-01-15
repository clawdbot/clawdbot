import { describe, expect, it, vi } from "vitest";

describe("sandbox docker config", () => {
  it("accepts binds array in sandbox.docker config", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],
            },
          },
        },
        list: [
          {
            id: "main",
            sandbox: {
              docker: {
                image: "custom-sandbox:latest",
                binds: ["/home/user/projects:/projects:ro"],
              },
            },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.docker?.binds).toEqual([
        "/var/run/docker.sock:/var/run/docker.sock",
        "/home/user/source:/source:rw",
      ]);
      expect(res.config.agents?.list?.[0]?.sandbox?.docker?.binds).toEqual([
        "/home/user/projects:/projects:ro",
      ]);
    }
  });

  it("rejects non-string values in binds array", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              binds: [123, "/valid/path:/path"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});
