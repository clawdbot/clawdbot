// Sandbox config validation rejects environment values the selected container transport cannot carry.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("sandbox container environment config validation", () => {
  it("rejects multiline default Docker environment values before runtime", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              env: { SYNTHETIC_MULTILINE: "synthetic-first\nsynthetic-second" },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          path: "agents.defaults.sandbox.docker.env.SYNTHETIC_MULTILINE",
          message: expect.stringContaining("single-line"),
        }),
      ]);
    }
  });

  it.each([
    {
      description: "explicit Docker multiline values",
      backend: "docker",
      key: "SYNTHETIC_DOCKER_MULTILINE",
      value: "synthetic-docker-first\nsynthetic-docker-second",
    },
    {
      description: "Podman multiline values",
      backend: "podman",
      key: "SYNTHETIC_PODMAN_MULTILINE",
      value: "synthetic-podman-first\r\nsynthetic-podman-second",
    },
    {
      description: "nonportable environment names",
      backend: "docker",
      key: "SYNTHETIC-BAD-NAME",
      value: "synthetic-private-invalid-name-value",
    },
    {
      description: "NUL-containing values",
      backend: "podman",
      key: "SYNTHETIC_NUL",
      value: "synthetic-private-before\0synthetic-private-after",
    },
  ])("rejects $description without exposing environment values", ({ backend, key, value }) => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          sandbox: { backend, docker: { env: { [key]: value } } },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      const issue = result.issues[0]!;
      expect(issue.path).toBe(`agents.defaults.sandbox.docker.env.${key}`);
      expect(issue.message).toContain(key);
      expect(issue.message).toContain(backend === "podman" ? "Podman" : "Docker");
      expect(issue.message).toContain("portable");
      expect(issue.message).toContain("single-line");
      expect(issue.message).toContain("NUL");
      expect(issue.message).toContain("line-delimited");
      expect(issue.message).toContain("openclaw doctor");
      expect(issue.message).toContain("manual remediation");
      expect(issue.message).toContain("SSH/OpenShell");
      expect(issue.message).not.toContain("doctor --fix");
      if (key === "SYNTHETIC-BAD-NAME") {
        expect(issue.message).toContain("Rename key");
      } else {
        expect(issue.message).toContain("mounted file or custom image");
      }
      for (const fragment of value.split(/[\r\n\0]/u).filter(Boolean)) {
        expect(issue.message).not.toContain(fragment);
      }
    }
  });

  it.each(["ssh", "openshell", "synthetic-plugin-backend"])(
    "accepts multiline environment values for the %s backend",
    (backend) => {
      expect(
        validateConfigObject({
          agents: {
            defaults: {
              sandbox: {
                backend,
                docker: { env: { SYNTHETIC_REMOTE_VALUE: "synthetic-first\nsynthetic-second" } },
              },
            },
          },
        }).ok,
      ).toBe(true);
    },
  );

  it("accepts unused Docker defaults when every explicit agent selects a remote backend", () => {
    const result = validateConfigObject({
      agents: {
        ownership: "explicit",
        defaults: {
          sandbox: {
            backend: "docker",
            docker: { env: { SYNTHETIC_UNUSED: "synthetic-first\nsynthetic-second" } },
          },
        },
        entries: {
          synthetic_ssh: { sandbox: { backend: "ssh" } },
          synthetic_openshell: { sandbox: { backend: "openshell" } },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("reports inherited invalid defaults once for effective agent container backends", () => {
    const result = validateConfigObject({
      agents: {
        ownership: "explicit",
        defaults: {
          sandbox: {
            backend: "ssh",
            docker: { env: { SYNTHETIC_INHERITED: "synthetic-first\nsynthetic-second" } },
          },
        },
        entries: {
          synthetic_docker: { sandbox: { backend: "docker" } },
          synthetic_podman: { sandbox: { backend: "podman" } },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.path).toBe("agents.defaults.sandbox.docker.env.SYNTHETIC_INHERITED");
    }
  });

  it.each([
    {
      description: "keyed agent entries",
      roster: {
        entries: {
          synthetic_agent: {
            sandbox: {
              backend: "docker",
              docker: { env: { SYNTHETIC_AGENT_VALUE: "synthetic-first\nsynthetic-second" } },
            },
          },
        },
      },
      path: "agents.entries.synthetic_agent.sandbox.docker.env.SYNTHETIC_AGENT_VALUE",
    },
    {
      description: "legacy agent list entries",
      roster: {
        list: [
          {
            id: "synthetic_agent",
            sandbox: {
              backend: "podman",
              docker: { env: { SYNTHETIC_AGENT_VALUE: "synthetic-first\nsynthetic-second" } },
            },
          },
        ],
      },
      path: "agents.list.0.sandbox.docker.env.SYNTHETIC_AGENT_VALUE",
    },
  ])("points agent-owned invalid values at $description", ({ roster, path }) => {
    const config = {
      agents: {
        defaults: { sandbox: { backend: "ssh" } },
        ...roster,
      },
    };
    const result = validateConfigObject(config, { sourceRaw: config });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([expect.objectContaining({ path })]);
    }
  });

  it("ignores agent Docker environment overrides that shared scope does not use", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            scope: "shared",
            docker: { env: { SYNTHETIC_SHARED: "synthetic-single-line" } },
          },
        },
        entries: {
          synthetic_agent: {
            sandbox: {
              docker: {
                env: { SYNTHETIC_IGNORED: "synthetic-ignored-first\nsynthetic-ignored-second" },
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it.each([undefined, "docker", "podman"])(
    "accepts portable names and single-line values for backend %s",
    (backend) => {
      expect(
        validateConfigObject({
          agents: {
            defaults: {
              sandbox: {
                ...(backend ? { backend } : {}),
                docker: {
                  env: {
                    SYNTHETIC_EMPTY: "",
                    SYNTHETIC_VALUE_1: " synthetic=value 🦞 ",
                  },
                },
              },
            },
          },
        }).ok,
      ).toBe(true);
    },
  );
});
