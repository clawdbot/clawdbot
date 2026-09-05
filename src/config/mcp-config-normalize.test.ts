// Verifies canonicalization of a single configured MCP server record.
// Covers legacy `type` alias resolution, snake_case to camelCase migration,
// canonical field priority, nested codex normalization, and idempotency.
import { describe, expect, it } from "vitest";
import { canonicalizeConfiguredMcpServer } from "./mcp-config-normalize.js";

describe("canonicalizeConfiguredMcpServer", () => {
  describe("transport alias", () => {
    it("fills canonical transport from legacy type when transport is unset (http)", () => {
      const result = canonicalizeConfiguredMcpServer({ type: "http", command: "uvx" });
      expect(result.transport).toBe("streamable-http");
      expect(result.type).toBeUndefined();
    });

    it("fills canonical transport from legacy type when transport is unset (sse)", () => {
      const result = canonicalizeConfiguredMcpServer({ type: "sse", url: "https://example" });
      expect(result.transport).toBe("sse");
      expect(result.type).toBeUndefined();
    });

    it("preserves an explicit canonical transport over a legacy type", () => {
      const result = canonicalizeConfiguredMcpServer({
        type: "http",
        transport: "sse",
        url: "https://example",
      });
      expect(result.transport).toBe("sse");
      expect(result.type).toBeUndefined();
    });

    it("keeps an unknown type that cannot be rewritten", () => {
      const result = canonicalizeConfiguredMcpServer({ type: "udp", command: "run" });
      expect(result.type).toBe("udp");
      expect(result.transport).toBeUndefined();
    });

    it("drops a stdio type alias without filling transport (stdio is identified by command at runtime)", () => {
      const result = canonicalizeConfiguredMcpServer({
        type: "stdio",
        command: "uvx",
        args: ["server"],
      });
      expect(result.type).toBeUndefined();
      expect(result.transport).toBeUndefined();
      expect(result.command).toBe("uvx");
    });
  });

  describe("workingDirectory to cwd", () => {
    it("fills cwd from workingDirectory when cwd is unset", () => {
      const result = canonicalizeConfiguredMcpServer({
        command: "run",
        workingDirectory: "/tmp/work",
      });
      expect(result.cwd).toBe("/tmp/work");
      expect(result.workingDirectory).toBeUndefined();
    });

    it("preserves an explicit cwd over workingDirectory", () => {
      const result = canonicalizeConfiguredMcpServer({
        command: "run",
        cwd: "/explicit",
        workingDirectory: "/legacy",
      });
      expect(result.cwd).toBe("/explicit");
      expect(result.workingDirectory).toBeUndefined();
    });

    it("drops a non-string workingDirectory without filling cwd", () => {
      const result = canonicalizeConfiguredMcpServer({ workingDirectory: 12345 });
      expect(result.workingDirectory).toBeUndefined();
      expect(result.cwd).toBeUndefined();
    });
  });

  describe("snake_case to camelCase migration", () => {
    it("fills supportsParallelToolCalls from supports_parallel_tool_calls", () => {
      const result = canonicalizeConfiguredMcpServer({ supports_parallel_tool_calls: true });
      expect(result.supportsParallelToolCalls).toBe(true);
      expect(result.supports_parallel_tool_calls).toBeUndefined();
    });

    it("preserves an explicit supportsParallelToolCalls over the snake_case form", () => {
      const result = canonicalizeConfiguredMcpServer({
        supports_parallel_tool_calls: false,
        supportsParallelToolCalls: true,
      });
      expect(result.supportsParallelToolCalls).toBe(true);
      expect(result.supports_parallel_tool_calls).toBeUndefined();
    });

    it("fills sslVerify from ssl_verify", () => {
      const result = canonicalizeConfiguredMcpServer({ ssl_verify: false });
      expect(result.sslVerify).toBe(false);
      expect(result.ssl_verify).toBeUndefined();
    });

    it("preserves an explicit sslVerify over ssl_verify", () => {
      const result = canonicalizeConfiguredMcpServer({ ssl_verify: true, sslVerify: false });
      expect(result.sslVerify).toBe(false);
      expect(result.ssl_verify).toBeUndefined();
    });

    it("fills clientCert from client_cert", () => {
      const result = canonicalizeConfiguredMcpServer({ client_cert: "/cert.pem" });
      expect(result.clientCert).toBe("/cert.pem");
      expect(result.client_cert).toBeUndefined();
    });

    it("preserves an explicit clientCert over client_cert", () => {
      const result = canonicalizeConfiguredMcpServer({
        client_cert: "/legacy.pem",
        clientCert: "/explicit.pem",
      });
      expect(result.clientCert).toBe("/explicit.pem");
      expect(result.client_cert).toBeUndefined();
    });

    it("fills clientKey from client_key", () => {
      const result = canonicalizeConfiguredMcpServer({ client_key: "/key.pem" });
      expect(result.clientKey).toBe("/key.pem");
      expect(result.client_key).toBeUndefined();
    });

    it("preserves an explicit clientKey over client_key", () => {
      const result = canonicalizeConfiguredMcpServer({
        client_key: "/legacy-key.pem",
        clientKey: "/explicit-key.pem",
      });
      expect(result.clientKey).toBe("/explicit-key.pem");
      expect(result.client_key).toBeUndefined();
    });
  });

  describe("nested codex", () => {
    it("fills codex.defaultToolsApprovalMode from default_tools_approval_mode", () => {
      const result = canonicalizeConfiguredMcpServer({
        codex: { default_tools_approval_mode: "approve" },
      });
      expect(result.codex).toEqual({ defaultToolsApprovalMode: "approve" });
    });

    it("preserves an explicit codex.defaultToolsApprovalMode over the snake_case form", () => {
      const result = canonicalizeConfiguredMcpServer({
        codex: {
          default_tools_approval_mode: "auto",
          defaultToolsApprovalMode: "prompt",
        },
      });
      expect(result.codex).toEqual({ defaultToolsApprovalMode: "prompt" });
    });

    it("leaves a non-record codex value untouched", () => {
      const result = canonicalizeConfiguredMcpServer({ codex: "not-a-record" });
      expect(result.codex).toBe("not-a-record");
    });
  });

  describe("idempotency", () => {
    it("is idempotent: re-running on an already-canonical record changes nothing", () => {
      const canonical = canonicalizeConfiguredMcpServer({
        type: "http",
        command: "uvx",
        workingDirectory: "/tmp/work",
        supports_parallel_tool_calls: true,
        ssl_verify: false,
        client_cert: "/cert.pem",
        client_key: "/key.pem",
        codex: { default_tools_approval_mode: "approve" },
      });
      const rerun = canonicalizeConfiguredMcpServer(canonical);
      expect(rerun).toEqual(canonical);
    });
  });
});
