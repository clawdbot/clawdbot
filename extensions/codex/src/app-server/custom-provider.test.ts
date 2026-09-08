import { describe, expect, it } from "vitest";
import {
  assertCodexCustomProviderEffectiveConfig,
  assertCodexCustomProviderResponse,
  assertCodexCustomProviderThreadConfig,
  CODEX_CUSTOM_PROVIDER_API_KEY_ENV,
  normalizeCodexCustomProviderBaseUrl,
  normalizeCodexCustomProviderId,
} from "./custom-provider.js";

const binding = { provider: "responses-proxy", baseUrl: "https://proxy.example/v1" };
const nativeProvider = {
  base_url: "https://proxy.example/v1/",
  wire_api: "responses",
  requires_openai_auth: false,
  env_key: CODEX_CUSTOM_PROVIDER_API_KEY_ENV,
};

function effectiveConfig(overrides: Record<string, unknown> = {}) {
  return {
    allow_login_shell: false,
    features: { shell_snapshot: false },
    shell_environment_policy: { experimental_use_profile: false, set: { CODEX_API_KEY: "" } },
    model_provider: "openai",
    model_providers: { [binding.provider]: { ...nativeProvider, ...overrides } },
  };
}

describe("custom Codex provider binding", () => {
  it.each([
    { shell_environment_policy: {} },
    {
      shell_environment_policy: {
        experimental_use_profile: false,
        set: { CODEX_API_KEY: "synthetic-override" },
      },
    },
    { features: { shell_snapshot: true } },
    { allow_login_shell: true },
  ])("rejects unsafe native shell credential policy: %j", (policy) => {
    expect(() =>
      assertCodexCustomProviderEffectiveConfig(binding, { ...effectiveConfig(), ...policy }),
    ).toThrow(/shell credential isolation/);
  });

  it.each([
    "shell_environment_policy.set.CODEX_API_KEY",
    '"shell_environment_policy".set.CODEX_API_KEY',
    'features."shell_snapshot"',
    '"allow_login_shell"',
  ])("rejects alternate managed shell policy paths: %s", (key) => {
    expect(() => assertCodexCustomProviderThreadConfig({ [key]: true })).toThrow();
  });

  it("admits a matching explicit provider independently of the server default", () => {
    expect(() =>
      assertCodexCustomProviderEffectiveConfig(binding, effectiveConfig()),
    ).not.toThrow();
    expect(() =>
      assertCodexCustomProviderEffectiveConfig(
        binding,
        effectiveConfig({ wire_api: undefined, requires_openai_auth: undefined }),
      ),
    ).not.toThrow();
  });

  it.each([undefined, {}, { model_providers: [] }, { model_providers: { other: nativeProvider } }])(
    "rejects absent or malformed native provider declarations: %j",
    (config) => {
      expect(() => assertCodexCustomProviderEffectiveConfig(binding, config)).toThrow(/missing/);
    },
  );

  it.each([
    "https://other.example/v1",
    "http://proxy.example/v1",
    "https://proxy.example/v2",
    "https://proxy.example:8443/v1",
    "https://proxy.example/v1?route=other",
    "https://secret@proxy.example/v1",
    undefined,
  ])("rejects changed or missing endpoints: %s", (base_url) => {
    expect(() =>
      assertCodexCustomProviderEffectiveConfig(binding, effectiveConfig({ base_url })),
    ).toThrow(/endpoint/);
  });

  it.each([
    { wire_api: "chat" },
    { wire_api: null },
    { requires_openai_auth: true },
    { requires_openai_auth: "false" },
    { env_key: "AMBIENT_PROVIDER_KEY" },
    { env_key: undefined },
    { supports_websockets: true },
    { supports_websockets: "false" },
    { auth: { type: "command", command: "credential-helper" } },
    { aws: {} },
    { experimental_bearer_token: "alternate-workload-key" },
    { query_params: { route: "other" } },
    { http_headers: { Authorization: "Bearer alternate-workload-key" } },
    { env_http_headers: { Authorization: "AMBIENT_PROVIDER_KEY" } },
    { http_headers: [] },
  ])("rejects native auth or transport drift: %j", (overrides) => {
    expect(() =>
      assertCodexCustomProviderEffectiveConfig(binding, effectiveConfig(overrides)),
    ).toThrow();
  });

  it("allows empty optional request maps without treating them as overrides", () => {
    expect(() =>
      assertCodexCustomProviderEffectiveConfig(
        binding,
        effectiveConfig({ query_params: {}, http_headers: {}, env_http_headers: {} }),
      ),
    ).not.toThrow();
  });

  it.each([
    { model_provider: "other" },
    { model_providers: { "responses-proxy": { base_url: "https://other.example/v1" } } },
    { "model_providers.responses-proxy.env_key": "AMBIENT_PROVIDER_KEY" },
    { '"model_providers".responses-proxy.env_key': "AMBIENT_PROVIDER_KEY" },
    { '"model_\\u0070roviders".responses-proxy.env_key': "AMBIENT_PROVIDER_KEY" },
    { " 'model_provider' ": "other" },
    { "profiles.other.model_provider": "other" },
    { profile: "other" },
    { model: "other-model" },
    { openai_base_url: "https://other.example/v1" },
    { cli_auth_credentials_store: "file" },
  ])("rejects route replacement in final thread patches: %j", (config) => {
    expect(() => assertCodexCustomProviderThreadConfig(config)).toThrow(/cannot override/);
  });

  it("preserves unrelated thread configuration", () => {
    expect(() =>
      assertCodexCustomProviderThreadConfig({
        features: { shell_tool: false },
        mcp_servers: { tools: { command: "tool-server" } },
      }),
    ).not.toThrow();
    expect(() => assertCodexCustomProviderThreadConfig(undefined)).not.toThrow();
    expect(() => assertCodexCustomProviderThreadConfig([])).toThrow(/object/);
  });

  it.each([undefined, null, "openai", "other", "RESPONSES-PROXY", "responses-proxy "])(
    "rejects missing or changed response provider identity: %s",
    (provider) => {
      expect(() => assertCodexCustomProviderResponse(binding, provider)).toThrow(
        /different provider/,
      );
    },
  );

  it("accepts the exact requested response provider", () => {
    expect(() => assertCodexCustomProviderResponse(binding, binding.provider)).not.toThrow();
  });
});

describe("custom provider route normalization", () => {
  it("normalizes custom IDs and equivalent URL spellings", () => {
    expect(normalizeCodexCustomProviderId(" Responses-Proxy ")).toBe("responses-proxy");
    expect(normalizeCodexCustomProviderBaseUrl(" HTTPS://PROXY.EXAMPLE:443/v1/ ")).toBe(
      binding.baseUrl,
    );
    expect(normalizeCodexCustomProviderBaseUrl("http://localhost:8080/v1/")).toBe(
      "http://localhost:8080/v1",
    );
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("permits loopback HTTP providers: %s", (host) => {
    const url = `http://${host}:8080/v1`;
    expect(normalizeCodexCustomProviderBaseUrl(url)).toBe(url);
  });

  it.each(["proxy.example", "localhost.example", "192.168.1.2", "[2001:db8::1]"])(
    "rejects non-loopback plaintext provider routes: %s",
    (host) => {
      const url = `http://${host}/v1`;
      expect(normalizeCodexCustomProviderBaseUrl(url)).toBeUndefined();
      expect(() =>
        assertCodexCustomProviderEffectiveConfig(
          { ...binding, baseUrl: url },
          effectiveConfig({ base_url: url }),
        ),
      ).toThrow(/endpoint/);
    },
  );

  it.each([
    "codex",
    "OPENAI",
    "constructor",
    "__proto__",
    "prototype",
    "a.b",
    "a/b",
    "a b",
    "",
    null,
  ])("excludes reserved or ambiguous provider IDs: %s", (id) => {
    expect(normalizeCodexCustomProviderId(id)).toBeUndefined();
  });

  it.each([
    "ftp://proxy.example/v1",
    "https://user@proxy.example/v1",
    "https://@proxy.example/v1",
    "https://proxy.example/v1?",
    "https://proxy.example/v1#",
    "https://proxy.example/v1#fragment",
    "https://proxy.\nexample/v1",
    "/v1",
    null,
  ])("rejects endpoints with hidden auth or routing semantics: %s", (url) => {
    expect(normalizeCodexCustomProviderBaseUrl(url)).toBeUndefined();
  });
});
