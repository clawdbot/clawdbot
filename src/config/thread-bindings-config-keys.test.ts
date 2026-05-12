import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("thread binding config keys", () => {
  it("rejects legacy session.threadBindings.ttlHours", () => {
    const result = validateConfigObjectRaw({
      session: {
        threadBindings: {
          ttlHours: 24,
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const threadBindingIssue = result.issues.find(
      (issue) => issue.path === "session.threadBindings",
    );
    expect(threadBindingIssue?.message).toContain("ttlHours");
  });

  it("accepts channel-level thread binding ttlHours compatibility", () => {
    const result = validateConfigObjectRaw({
      channels: {
        demo: {
          threadBindings: {
            ttlHours: 24,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts account-level thread binding ttlHours compatibility", () => {
    const result = validateConfigObjectRaw({
      channels: {
        demo: {
          accounts: {
            alpha: {
              threadBindings: {
                ttlHours: 24,
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });
});
