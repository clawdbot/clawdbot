// Covers preserved environment-variable config normalization.
import { describe, it, expect } from "vitest";
import { restoreEnvVarRefs } from "./env-preserve.js";

describe("restoreEnvVarRefs", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-api03-real-key",
    OPENAI_API_KEY: "sk-openai-real-key",
    MY_TOKEN: "tok-12345",
  } as unknown as NodeJS.ProcessEnv;

  it("restores a simple ${VAR} reference when value matches", () => {
    const incoming = { apiKey: "sk-ant-api03-real-key" };
    const parsed = { apiKey: "${ANTHROPIC_API_KEY}" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ apiKey: "${ANTHROPIC_API_KEY}" });
  });

  it("keeps new value when caller intentionally changed it", () => {
    const incoming = { apiKey: "sk-ant-new-different-key" };
    const parsed = { apiKey: "${ANTHROPIC_API_KEY}" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ apiKey: "sk-ant-new-different-key" });
  });

  it("handles nested objects", () => {
    const incoming = {
      models: {
        providers: {
          anthropic: { apiKey: "sk-ant-api03-real-key" },
          openai: { apiKey: "sk-openai-real-key" },
        },
      },
    };
    const parsed = {
      models: {
        providers: {
          anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
          openai: { apiKey: "${OPENAI_API_KEY}" },
        },
      },
    };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({
      models: {
        providers: {
          anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
          openai: { apiKey: "${OPENAI_API_KEY}" },
        },
      },
    });
  });

  it("preserves new keys not in parsed", () => {
    const incoming = { apiKey: "sk-ant-api03-real-key", newField: "hello" };
    const parsed = { apiKey: "${ANTHROPIC_API_KEY}" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ apiKey: "${ANTHROPIC_API_KEY}", newField: "hello" });
  });

  it("handles non-env-var strings (no restoration needed)", () => {
    const incoming = { name: "my-config" };
    const parsed = { name: "my-config" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ name: "my-config" });
  });

  it("handles arrays", () => {
    const incoming = ["sk-ant-api03-real-key", "literal"];
    const parsed = ["${ANTHROPIC_API_KEY}", "literal"];
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual(["${ANTHROPIC_API_KEY}", "literal"]);
  });

  it("handles null/undefined parsed gracefully", () => {
    const incoming = { apiKey: "sk-ant-api03-real-key" };
    expect(restoreEnvVarRefs(incoming, null, env)).toEqual(incoming);
    expect(restoreEnvVarRefs(incoming, undefined, env)).toEqual(incoming);
  });

  it("handles missing env var (cannot verify match)", () => {
    const envMissing = {} as unknown as NodeJS.ProcessEnv;
    const incoming = { apiKey: "some-value" };
    const parsed = { apiKey: "${MISSING_VAR}" };
    // Can't resolve the template, so keep incoming as-is
    const result = restoreEnvVarRefs(incoming, parsed, envMissing);
    expect(result).toEqual({ apiKey: "some-value" });
  });

  it("handles composite template strings like prefix-${VAR}-suffix", () => {
    const incoming = { url: "https://tok-12345.example.com" };
    const parsed = { url: "https://${MY_TOKEN}.example.com" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ url: "https://${MY_TOKEN}.example.com" });
  });

  it("restores partially resolved templates when missing vars remain literal", () => {
    const partialEnv = { API_TOKEN: "secret" } as unknown as NodeJS.ProcessEnv;
    const incoming = { value: "secret:${OPTIONAL_SUFFIX}" };
    const parsed = { value: "${API_TOKEN}:${OPTIONAL_SUFFIX}" };

    const result = restoreEnvVarRefs(incoming, parsed, partialEnv);

    expect(result).toEqual({ value: "${API_TOKEN}:${OPTIONAL_SUFFIX}" });
  });

  it("rejects structural changes to arrays containing environment references", () => {
    const duplicateEnv = {
      PLUGIN_A: "same-plugin",
      PLUGIN_B: "same-plugin",
    } as unknown as NodeJS.ProcessEnv;

    expect(() =>
      restoreEnvVarRefs(["same-plugin"], ["${PLUGIN_A}", "${PLUGIN_B}"], duplicateEnv),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("allows array edits when placeholders are escaped literals", () => {
    const result = restoreEnvVarRefs(
      ["${ESCAPED}", "changed"],
      ["$${ESCAPED}", "literal"],
      {} as NodeJS.ProcessEnv,
    );

    expect(result).toEqual(["$${ESCAPED}", "changed"]);
  });

  it("restores escaped literals beside real environment-backed array entries", () => {
    const result = restoreEnvVarRefs(["secret", "${ESCAPED}"], ["${TOKEN}", "$${ESCAPED}"], {
      TOKEN: "secret",
    } as unknown as NodeJS.ProcessEnv);

    expect(result).toEqual(["${TOKEN}", "$${ESCAPED}"]);
  });

  it("allows appending after stable environment-backed array entries", () => {
    const result = restoreEnvVarRefs(["base-plugin", "extra-plugin"], ["${BASE_PLUGIN}"], {
      BASE_PLUGIN: "base-plugin",
    } as unknown as NodeJS.ProcessEnv);

    expect(result).toEqual(["${BASE_PLUGIN}", "extra-plugin"]);
  });

  it("allows removing a unique environment-backed array entry", () => {
    const result = restoreEnvVarRefs([], ["${BASE_PLUGIN}"], {
      BASE_PLUGIN: "base-plugin",
    } as unknown as NodeJS.ProcessEnv);

    expect(result).toEqual([]);
  });

  it("preserves an env-backed allow entry while removing the same plugin from env-backed deny", () => {
    const result = restoreEnvVarRefs(
      {
        plugins: {
          allow: ["base-plugin", "demo"],
          deny: ["keep"],
        },
      },
      {
        plugins: {
          allow: ["${BASE_PLUGIN}"],
          deny: ["${DENIED_PLUGIN}", "keep"],
        },
      },
      {
        BASE_PLUGIN: "base-plugin",
        DENIED_PLUGIN: "demo",
      } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual({
      plugins: {
        allow: ["${BASE_PLUGIN}", "demo"],
        deny: ["keep"],
      },
    });
  });

  it("allows replacing a unique environment-backed array entry", () => {
    const result = restoreEnvVarRefs(["replacement"], ["${BASE_PLUGIN}"], {
      BASE_PLUGIN: "base-plugin",
    } as unknown as NodeJS.ProcessEnv);

    expect(result).toEqual(["replacement"]);
  });

  it("allows in-place object edits when stable ids preserve array identity", () => {
    const result = restoreEnvVarRefs(
      [{ id: "main", workspace: "/workspace/main", name: "new" }],
      [{ id: "main", workspace: "${WORKSPACE}", name: "old" }],
      { WORKSPACE: "/workspace/main" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([{ id: "main", workspace: "${WORKSPACE}", name: "new" }]);
  });

  it("allows single-position edits to env-backed array objects without stable ids", () => {
    const result = restoreEnvVarRefs(
      [{ name: "new", token: "secret" }],
      [{ name: "old", token: "${TOKEN}" }],
      { TOKEN: "secret" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([{ name: "new", token: "${TOKEN}" }]);
  });

  it("allows appending after unchanged env-backed array objects without ids", () => {
    const result = restoreEnvVarRefs(
      [{ match: { peer: { id: "peer-1" } } }, { match: { peer: { id: "peer-2" } } }],
      [{ match: { peer: { id: "${PEER_ID}" } } }],
      { PEER_ID: "peer-1" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([
      { match: { peer: { id: "${PEER_ID}" } } },
      { match: { peer: { id: "peer-2" } } },
    ]);
  });

  it("rejects editing an env-backed array object while appending without stable identity", () => {
    expect(() =>
      restoreEnvVarRefs(
        [
          { name: "new", token: "secret" },
          { name: "second", token: "literal" },
        ],
        [{ name: "old", token: "${TOKEN}" }],
        { TOKEN: "secret" } as unknown as NodeJS.ProcessEnv,
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("rejects reordered and edited env-backed array objects without stable ids", () => {
    expect(() =>
      restoreEnvVarRefs(
        [
          { name: "second-next", token: "secret-b" },
          { name: "first-next", token: "secret-a" },
        ],
        [
          { name: "first", token: "${TOKEN_A}" },
          { name: "second", token: "${TOKEN_B}" },
        ],
        {
          TOKEN_A: "secret-a",
          TOKEN_B: "secret-b",
        } as unknown as NodeJS.ProcessEnv,
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("rejects identity swaps that leave old resolved secrets at their original positions", () => {
    expect(() =>
      restoreEnvVarRefs(
        [
          { account: "second", token: "secret-a" },
          { account: "first", token: "secret-b" },
        ],
        [
          { account: "first", token: "${TOKEN_A}" },
          { account: "second", token: "${TOKEN_B}" },
        ],
        {
          TOKEN_A: "secret-a",
          TOKEN_B: "secret-b",
        } as unknown as NodeJS.ProcessEnv,
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("allows multi-item object edits with unique agentId identities", () => {
    const result = restoreEnvVarRefs(
      [
        { agentId: "first", name: "first-next", match: { peer: { id: "peer-a" } } },
        { agentId: "second", name: "second-next", match: { peer: { id: "peer-b" } } },
      ],
      [
        { agentId: "first", name: "first", match: { peer: { id: "${PEER_A}" } } },
        { agentId: "second", name: "second", match: { peer: { id: "${PEER_B}" } } },
      ],
      {
        PEER_A: "peer-a",
        PEER_B: "peer-b",
      } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([
      { agentId: "first", name: "first-next", match: { peer: { id: "${PEER_A}" } } },
      { agentId: "second", name: "second-next", match: { peer: { id: "${PEER_B}" } } },
    ]);
  });

  it("allows nested accountId changes when agentId preserves array identity", () => {
    const result = restoreEnvVarRefs(
      [{ agentId: "main", match: { accountId: "next" }, token: "secret" }],
      [{ agentId: "main", match: { accountId: "old" }, token: "${TOKEN}" }],
      { TOKEN: "secret" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([{ agentId: "main", match: { accountId: "next" }, token: "${TOKEN}" }]);
  });

  it("allows changing an accountId routing field on a single env-backed target", () => {
    const result = restoreEnvVarRefs(
      [{ accountId: "next", to: "user@example.com" }],
      [{ accountId: "old", to: "${APPROVAL_TARGET}" }],
      { APPROVAL_TARGET: "user@example.com" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([{ accountId: "next", to: "${APPROVAL_TARGET}" }]);
  });

  it("allows changing one unambiguous target in a multi-entry env-backed array", () => {
    const result = restoreEnvVarRefs(
      [
        { accountId: "next", to: "user-a@example.com" },
        { accountId: "second", to: "user-b@example.com" },
      ],
      [
        { accountId: "old", to: "${APPROVAL_TARGET_A}" },
        { accountId: "second", to: "${APPROVAL_TARGET_B}" },
      ],
      {
        APPROVAL_TARGET_A: "user-a@example.com",
        APPROVAL_TARGET_B: "user-b@example.com",
      } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([
      { accountId: "next", to: "${APPROVAL_TARGET_A}" },
      { accountId: "second", to: "${APPROVAL_TARGET_B}" },
    ]);
  });

  it("allows same-index non-string edits when every authored literal string stays unchanged", () => {
    const result = restoreEnvVarRefs(
      [
        { account: "first", enabled: true, token: "secret-a" },
        { account: "second", enabled: false, token: "secret-b" },
      ],
      [
        { account: "first", enabled: false, token: "${TOKEN_A}" },
        { account: "second", enabled: true, token: "${TOKEN_B}" },
      ],
      {
        TOKEN_A: "secret-a",
        TOKEN_B: "secret-b",
      } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([
      { account: "first", enabled: true, token: "${TOKEN_A}" },
      { account: "second", enabled: false, token: "${TOKEN_B}" },
    ]);
  });

  it("allows deleting an env-backed array object without a stable id", () => {
    const result = restoreEnvVarRefs(
      [{ agentId: "second", match: { peer: { id: "peer-b" } } }],
      [
        { agentId: "first", match: { peer: { id: "${PEER_A}" } } },
        { agentId: "second", match: { peer: { id: "peer-b" } } },
      ],
      { PEER_A: "peer-a" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([{ agentId: "second", match: { peer: { id: "peer-b" } } }]);
  });

  it("allows deleting multiple env-backed array objects without stable ids", () => {
    const result = restoreEnvVarRefs(
      [{ agentId: "retained", match: { peer: { id: "peer-c" } } }],
      [
        { agentId: "first", match: { peer: { id: "${PEER_A}" } } },
        { agentId: "second", match: { peer: { id: "${PEER_B}" } } },
        { agentId: "retained", match: { peer: { id: "peer-c" } } },
      ],
      {
        PEER_A: "peer-a",
        PEER_B: "peer-b",
      } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([{ agentId: "retained", match: { peer: { id: "peer-c" } } }]);
  });

  it("rejects reordered template entries with duplicate stable ids", () => {
    expect(() =>
      restoreEnvVarRefs(
        [
          { id: "duplicate", workspace: "/workspace/b", name: "b" },
          { id: "duplicate", workspace: "/workspace/a", name: "a" },
        ],
        [
          { id: "duplicate", workspace: "${WORKSPACE_A}", name: "a" },
          { id: "duplicate", workspace: "${WORKSPACE_B}", name: "b" },
        ],
        {
          WORKSPACE_A: "/workspace/a",
          WORKSPACE_B: "/workspace/b",
        } as unknown as NodeJS.ProcessEnv,
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("rejects removing one of two template entries with duplicate stable ids", () => {
    expect(() =>
      restoreEnvVarRefs(
        [{ id: "duplicate", sessionKey: "same" }],
        [
          { id: "duplicate", sessionKey: "${SESSION_A}" },
          { id: "duplicate", sessionKey: "${SESSION_B}" },
        ],
        {
          SESSION_A: "same",
          SESSION_B: "same",
        } as unknown as NodeJS.ProcessEnv,
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("allows deleting a templated entry beside a uniquely retained duplicate-id sibling", () => {
    const result = restoreEnvVarRefs(
      [{ id: "duplicate", sessionKey: "literal" }],
      [
        { id: "duplicate", sessionKey: "${SESSION_KEY}" },
        { id: "duplicate", sessionKey: "literal" },
      ],
      { SESSION_KEY: "secret" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([{ id: "duplicate", sessionKey: "literal" }]);
  });

  it("rejects renaming stable ids on env-backed array objects", () => {
    expect(() =>
      restoreEnvVarRefs([{ id: "new", token: "secret" }], [{ id: "old", token: "${TOKEN}" }], {
        TOKEN: "secret",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("allows deleting a uniquely identified env-backed array entry", () => {
    const result = restoreEnvVarRefs(
      [{ id: "main", workspace: "/workspace/main" }],
      [
        { id: "main", workspace: "/workspace/main" },
        { id: "ops", workspace: "${OPS_WORKSPACE}" },
      ],
      { OPS_WORKSPACE: "/workspace/ops" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([{ id: "main", workspace: "/workspace/main" }]);
  });

  it("allows deleting a uniquely identified env-backed entry beside a sibling edit", () => {
    const result = restoreEnvVarRefs(
      [{ id: "main", name: "new" }],
      [
        { id: "ops", workspace: "${OPS_WORKSPACE}" },
        { id: "main", name: "old" },
      ],
      { OPS_WORKSPACE: "/workspace/ops" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([{ id: "main", name: "new" }]);
  });

  it("rejects same-index template matches against authored literal duplicates", () => {
    expect(() =>
      restoreEnvVarRefs(["same"], ["${PLUGIN_PATH}", "same"], {
        PLUGIN_PATH: "same",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("rejects same-index scalar matches after surrounding array restructuring", () => {
    expect(() =>
      restoreEnvVarRefs(["tail", "secret"], ["old", "${TOKEN}", "tail"], {
        TOKEN: "secret",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("allows trailing sibling edits beside a scalar environment reference", () => {
    const result = restoreEnvVarRefs(["base-plugin", "replacement"], ["${BASE_PLUGIN}", "old"], {
      BASE_PLUGIN: "base-plugin",
    } as unknown as NodeJS.ProcessEnv);

    expect(result).toEqual(["${BASE_PLUGIN}", "replacement"]);
  });

  it("allows prefix edits before a same-index scalar environment reference", () => {
    const result = restoreEnvVarRefs(["new", "base-plugin"], ["old", "${BASE_PLUGIN}"], {
      BASE_PLUGIN: "base-plugin",
    } as unknown as NodeJS.ProcessEnv);

    expect(result).toEqual(["new", "${BASE_PLUGIN}"]);
  });

  it("restores escaped literal moves without activating the reference", () => {
    const result = restoreEnvVarRefs(
      ["literal", "${TOKEN}"],
      ["$${TOKEN}", "literal"],
      {} as NodeJS.ProcessEnv,
    );

    expect(result).toEqual(["literal", "$${TOKEN}"]);
  });

  it("restores an escaped literal move beside a stable real environment reference", () => {
    const result = restoreEnvVarRefs(
      ["secret", "literal", "${ESCAPED}"],
      ["${TOKEN}", "$${ESCAPED}", "literal"],
      { TOKEN: "secret" } as unknown as NodeJS.ProcessEnv,
    );

    expect(result).toEqual(["${TOKEN}", "literal", "$${ESCAPED}"]);
  });

  it("preserves duplicate escaped literals when their positions stay stable", () => {
    const result = restoreEnvVarRefs(
      ["${TOKEN}", "${TOKEN}"],
      ["$${TOKEN}", "$${TOKEN}"],
      {} as NodeJS.ProcessEnv,
    );

    expect(result).toEqual(["$${TOKEN}", "$${TOKEN}"]);
  });

  it("rejects ambiguous escaped literal moves beside a new active reference", () => {
    expect(() =>
      restoreEnvVarRefs(
        ["literal", "${TOKEN}", "${TOKEN}"],
        ["$${TOKEN}", "literal"],
        {} as NodeJS.ProcessEnv,
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("restores escaped literals after stable-id object moves", () => {
    const result = restoreEnvVarRefs(
      [
        { id: "literal", token: "plain" },
        { id: "escaped", token: "${TOKEN}", enabled: true },
      ],
      [
        { id: "escaped", token: "$${TOKEN}", enabled: false },
        { id: "literal", token: "plain" },
      ],
      {} as NodeJS.ProcessEnv,
    );

    expect(result).toEqual([
      { id: "literal", token: "plain" },
      { id: "escaped", token: "$${TOKEN}", enabled: true },
    ]);
  });

  it("allows deleting an escaped literal entry with a stable id", () => {
    const result = restoreEnvVarRefs([], [{ id: "old", token: "$${TOKEN}" }], {});

    expect(result).toEqual([]);
  });

  it("allows deleting an escaped literal entry beside a stable-id sibling edit", () => {
    const result = restoreEnvVarRefs(
      [{ id: "main", name: "new" }],
      [
        { id: "escaped", token: "$${TOKEN}" },
        { id: "main", name: "old" },
      ],
      {},
    );

    expect(result).toEqual([{ id: "main", name: "new" }]);
  });

  it("restores escaped literals during a same-index object edit with stable neighbors", () => {
    const result = restoreEnvVarRefs(
      [{ token: "${TOKEN}", enabled: true }, "tail"],
      [{ token: "$${TOKEN}", enabled: false }, "tail"],
      {},
    );

    expect(result).toEqual([{ token: "$${TOKEN}", enabled: true }, "tail"]);
  });

  it("rejects restoring escaped literals onto a replacement stable-id entry", () => {
    expect(() =>
      restoreEnvVarRefs(
        [{ id: "new", token: "${TOKEN}" }],
        [{ id: "old", token: "$${TOKEN}" }],
        {},
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("allows replacing a stable-id escaped entry when no active reference remains", () => {
    const result = restoreEnvVarRefs(
      [{ id: "new", token: "plain" }],
      [{ id: "old", token: "$${TOKEN}" }],
      {},
    );

    expect(result).toEqual([{ id: "new", token: "plain" }]);
  });

  it("allows changing one of multiple identical escaped literals", () => {
    const result = restoreEnvVarRefs(["new", "${TOKEN}"], ["$${TOKEN}", "$${TOKEN}"], {});

    expect(result).toEqual(["new", "$${TOKEN}"]);
  });

  it("rejects ambiguous multi-item edits that could activate escaped literals", () => {
    expect(() =>
      restoreEnvVarRefs(
        [
          { token: "${A}", enabled: true },
          { token: "${B}", enabled: true },
        ],
        [
          { token: "$${A}", enabled: false },
          { token: "$${B}", enabled: false },
        ],
        {},
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("rejects escaped literal moves onto indexes claimed by real references", () => {
    expect(() =>
      restoreEnvVarRefs(["${B}", "changed"], ["${A}", "$${B}", "tail"], {
        A: "x",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("rejects escaped literal activation beside a changed stable-id entry", () => {
    expect(() =>
      restoreEnvVarRefs(
        [
          { id: "b", token: "${TOKEN}" },
          { id: "a", token: "changed" },
        ],
        [
          { id: "a", token: "$${TOKEN}" },
          { id: "b", token: "literal" },
        ],
        {},
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("preserves intentional real references beside same-name escaped literals", () => {
    const result = restoreEnvVarRefs(["secret", "${TOKEN}"], ["${TOKEN}", "$${TOKEN}"], {
      TOKEN: "secret",
    } as unknown as NodeJS.ProcessEnv);

    expect(result).toEqual(["${TOKEN}", "$${TOKEN}"]);
  });

  it("rejects ambiguous same-name real and escaped reference reorders", () => {
    expect(() =>
      restoreEnvVarRefs(["${TOKEN}", "secret"], ["${TOKEN}", "$${TOKEN}"], {
        TOKEN: "secret",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("rejects escaped references activated inside edited strings", () => {
    expect(() => restoreEnvVarRefs(["changed-${TOKEN}"], ["prefix-$${TOKEN}"], {})).toThrow(
      "Config write would reorder or modify an array containing environment references",
    );
  });

  it("rejects escaped references activated under a different object key", () => {
    expect(() => restoreEnvVarRefs([{ next: "${TOKEN}" }], [{ old: "$${TOKEN}" }], {})).toThrow(
      "Config write would reorder or modify an array containing environment references",
    );
  });

  it("does not let an existing active reference mask activation at another key", () => {
    expect(() =>
      restoreEnvVarRefs(
        [{ id: "x", moved: "${TOKEN}", active: "changed" }],
        [{ id: "x", literal: "$${TOKEN}", active: "${TOKEN}" }],
        {},
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("does not let a same-path active reference mask an activated escaped literal", () => {
    expect(() =>
      restoreEnvVarRefs(["changed-${TOKEN}"], ["${TOKEN}-$${TOKEN}"], {
        TOKEN: "secret",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("allows adding an active reference when a stable escaped entry remains preserved", () => {
    const result = restoreEnvVarRefs(
      [
        { id: "literal", token: "${TOKEN}" },
        { id: "new", token: "${TOKEN}" },
      ],
      [{ id: "literal", token: "$${TOKEN}" }],
      {},
    );

    expect(result).toEqual([
      { id: "literal", token: "$${TOKEN}" },
      { id: "new", token: "${TOKEN}" },
    ]);
  });

  it("rejects swapping same-name active and escaped values between stable-id entries", () => {
    expect(() =>
      restoreEnvVarRefs(
        [
          { id: "literal", token: "secret" },
          { id: "active", token: "${TOKEN}" },
        ],
        [
          { id: "literal", token: "$${TOKEN}" },
          { id: "active", token: "${TOKEN}" },
        ],
        { TOKEN: "secret" } as unknown as NodeJS.ProcessEnv,
      ),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("rejects replacing a scalar template while adding its resolved value elsewhere", () => {
    expect(() =>
      restoreEnvVarRefs(["replacement", "admin"], ["${ADMIN_ID}", "old"], {
        ADMIN_ID: "admin",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("rejects replacing a scalar template while adding its resolved value in a longer array", () => {
    expect(() =>
      restoreEnvVarRefs(["old", "replacement", "admin"], ["${ADMIN_ID}", "old"], {
        ADMIN_ID: "admin",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("Config write would reorder or modify an array containing environment references");
  });

  it("handles type mismatches between incoming and parsed", () => {
    // Caller changed type from string to number
    const incoming = { port: 8080 };
    const parsed = { port: "8080" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ port: 8080 });
  });

  it("does not restore when parsed value has no env var pattern", () => {
    const incoming = { apiKey: "sk-ant-api03-real-key" };
    const parsed = { apiKey: "sk-ant-api03-real-key" };
    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({ apiKey: "sk-ant-api03-real-key" });
  });

  // Edge case: env mutation between read and write (Greptile comment #1)
  // Scenario: config.env sets FOO=bar, which gets applied to process.env during loadConfig.
  // Later writeConfigFile runs — the env has changed since the original read.
  it("does not incorrectly restore when env var value changed between read and write", () => {
    // At read time, MY_VAR was "original-value" and resolved ${MY_VAR} → "original-value"
    // Then config.env or external mutation changed MY_VAR to "mutated-value"
    // Caller is writing back "original-value" (the value they got from the read)
    const mutatedEnv = { MY_VAR: "mutated-value" } as unknown as NodeJS.ProcessEnv;
    const incoming = { key: "original-value" };
    const parsed = { key: "${MY_VAR}" };

    const result = restoreEnvVarRefs(incoming, parsed, mutatedEnv);
    // Should NOT restore ${MY_VAR} because resolving it now gives "mutated-value",
    // which doesn't match "original-value" — the caller's value should be kept
    expect(result).toEqual({ key: "original-value" });
  });

  it("correctly restores when env var value hasn't changed", () => {
    const stableEnv = { MY_VAR: "stable-value" } as unknown as NodeJS.ProcessEnv;
    const incoming = { key: "stable-value" };
    const parsed = { key: "${MY_VAR}" };

    const result = restoreEnvVarRefs(incoming, parsed, stableEnv);
    // Env value matches incoming — safe to restore
    expect(result).toEqual({ key: "${MY_VAR}" });
  });

  it("does not restore when env snapshot differs from live env (TOCTOU fix)", () => {
    // With env snapshots: at read time MY_VAR was "old-value", so incoming is "old-value".
    // Caller changed it to "new-value". Live env also changed to "new-value".
    // But using the READ-TIME snapshot ("old-value"), we correctly see mismatch and keep incoming.
    const readTimeEnv = { MY_VAR: "old-value" } as unknown as NodeJS.ProcessEnv;
    const incoming = { key: "new-value" }; // caller intentionally changed this
    const parsed = { key: "${MY_VAR}" };

    const result = restoreEnvVarRefs(incoming, parsed, readTimeEnv);
    // Using read-time snapshot: ${MY_VAR} resolves to "old-value", doesn't match "new-value"
    // → correctly keeps caller's new value
    expect(result).toEqual({ key: "new-value" });
  });

  // Edge case: $${VAR} escape sequence (Greptile comment #2)
  it("handles $${VAR} escape sequence (literal ${VAR} in output)", () => {
    // In the config file: $${ANTHROPIC_API_KEY}
    // substituteString resolves this to literal "${ANTHROPIC_API_KEY}"
    // So incoming would be "${ANTHROPIC_API_KEY}" (the literal text)
    const incoming = { note: "${ANTHROPIC_API_KEY}" };
    const parsed = { note: "$${ANTHROPIC_API_KEY}" };

    const result = restoreEnvVarRefs(incoming, parsed, env);
    // Should restore the $${} escape, not try to resolve ${} inside it
    expect(result).toEqual({ note: "$${ANTHROPIC_API_KEY}" });
  });

  it("does not confuse $${VAR} escape with ${VAR} substitution", () => {
    // Config has both: an escaped ref and a real ref
    const incoming = {
      literal: "${MY_TOKEN}", // from $${MY_TOKEN} → literal "${MY_TOKEN}"
      resolved: "tok-12345", // from ${MY_TOKEN} → "tok-12345"
    };
    const parsed = {
      literal: "$${MY_TOKEN}", // escape sequence
      resolved: "${MY_TOKEN}", // real env var ref
    };

    const result = restoreEnvVarRefs(incoming, parsed, env);
    expect(result).toEqual({
      literal: "$${MY_TOKEN}", // should restore escape
      resolved: "${MY_TOKEN}", // should restore ref
    });
  });

  it("does not restore env refs from inherited parsed properties", () => {
    // isPlainObject accepts custom prototypes, but only own properties represent authored config.
    const parsed = Object.create({
      toString: "${TEST_VALUE}",
    }) as Record<string, unknown>;
    const testEnv = { TEST_VALUE: "resolved-value" } as unknown as NodeJS.ProcessEnv;

    expect(restoreEnvVarRefs({ toString: "resolved-value" }, parsed, testEnv)).toEqual({
      toString: "resolved-value",
    });
  });
});
