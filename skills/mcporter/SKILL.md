---
name: mcporter
description: "Discover, inspect, call, and read resources from MCP servers with mcporter."
homepage: https://mcporter.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "📦",
        "requires": { "anyBins": ["mcporter"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter (npm)",
            },
          ],
      },
  }
---

# mcporter

Use MCPorter as a command-line MCP client: discover servers and tools, call tools,
and list or read MCP Resources. Examples use `npx mcporter`; a globally installed
`mcporter` binary can replace that prefix.

## Discover servers and tools

Start with discovery rather than guessing a tool name:

```sh
npx mcporter list
npx mcporter list <server> --brief
npx mcporter list <server> --schema
```

## Call tools

Use a `server.tool` selector with named arguments, the signature syntax printed by
`list`, or an explicit JSON payload:

```sh
npx mcporter call linear.list_issues team=ENG limit:5
npx mcporter call 'linear.create_issue(title: "Bug", team: "ENG")'
npx mcporter call linear.list_issues --args '{"limit":5}'
```

Add `--output json` when another tool parses the result. Inspect the schema before
sending unfamiliar arguments, and do not invoke write, delete, or other mutating
tools without the user's authorization.

## List and read MCP Resources

`resource` covers the MCP `resources/list` and `resources/read` operations. Without a
URI it lists the server's Resources; with a URI it reads that one:

```sh
npx mcporter resource <server>
npx mcporter resource <server> <uri> --output json
```

Quote the URI when it contains `?`, `&`, or spaces.

## HTTP and stdio servers

`list`, `call`, and `auth` accept a server description for a single invocation, so no
config file is needed:

```sh
npx mcporter list --http-url https://mcp.example.com/mcp --name example --brief
npx mcporter list --http-url http://localhost:3001/mcp --allow-http --name local --brief
npx mcporter list --stdio "npx -y example-mcp@latest" --name local --brief
```

A cleartext `http://` endpoint is refused until `--allow-http` confirms it, including
loopback hosts like `localhost`, `127.0.0.1`, or `[::1]`.

These definitions are ephemeral, and `resource` only accepts a configured server, so
persist the endpoint first:

```sh
npx mcporter config add local http://localhost:3001/mcp
```

## Auth and config

```sh
npx mcporter auth <server-or-url> [--reset]
npx mcporter config list
npx mcporter config add <name> <url>
```

Keep credentials in environment placeholders or a local secret store; do not paste
tokens, headers, or OAuth URLs into prompts, committed config, or logs.

Run `npx mcporter --help` or `npx mcporter <command> --help` for the remaining
commands and flags in the installed version.

## References

- [MCPorter README and Core Workflows](https://github.com/openclaw/mcporter#core-workflows)
- [CLI reference](https://github.com/openclaw/mcporter/blob/main/docs/cli-reference.md)
- [MCP Resources specification](https://modelcontextprotocol.io/specification/latest/server/resources)
