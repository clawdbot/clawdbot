# MCP plugin-tools call

```yaml qa-scenario
id: mcp-plugin-tools-call
title: MCP plugin-tools call
surface: mcp
coverage:
  primary:
    - plugins.mcp-tools
  secondary:
    - tools.invocation
objective: Verify OpenClaw can expose plugin tools over MCP and a real MCP client can call one successfully.
successCriteria:
  - Plugin tools MCP server lists memory_search.
  - A real MCP client calls memory_search successfully.
  - The returned MCP payload includes the expected memory-only fact.
docsRefs:
  - docs/cli/mcp.md
  - docs/gateway/protocol.md
codeRefs:
  - src/mcp/plugin-tools-serve.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify OpenClaw can expose plugin tools over MCP and a real MCP client can call one successfully.
  config:
    memoryFact: "MCP fact: the codename is ORBIT-9."
    query: "ORBIT-9 codename"
    expectedNeedle: "ORBIT-9"
```

```yaml qa-flow
steps:
  - name: serves and calls memory_search over MCP
    actions:
      - call: fs.writeFile
        args:
          - expr: "path.join(env.gateway.workspaceDir, 'MEMORY.md')"
          - expr: "`${config.memoryFact}\\n`"
          - utf8
      - call: forceMemoryIndex
        args:
          - env:
              ref: env
            query:
              expr: config.query
            expectedNeedle:
              expr: config.expectedNeedle
      - call: callPluginToolsMcp
        saveAs: result
        args:
          - env:
              ref: env
            toolName: memory_search
            args:
              query:
                expr: config.query
              maxResults: 3
      - set: text
        value:
          expr: "JSON.stringify(result.content ?? [])"
      - assert:
          expr: "text.includes(config.expectedNeedle)"
          message:
            expr: "`MCP memory_search missed expected fact: ${text}`"
    detailsExpr: text
```
