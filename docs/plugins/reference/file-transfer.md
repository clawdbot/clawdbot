---
summary: "Fetch, list, and write files on paired nodes via dedicated node commands. Bypasses bash stdout truncation by using base64 over node.invoke for binaries up to 16 MB."
read_when:
  - You are installing, configuring, or auditing the file-transfer plugin
title: "File Transfer plugin"
---

# File Transfer plugin

Fetch, list, and write files on paired nodes via dedicated node commands. Bypasses bash stdout truncation by using base64 over node.invoke for binaries up to 16 MB.

## Distribution

- Package: `@openclaw/file-transfer`
- Install route: included in OpenClaw

## Surface

contracts: `tools`

<!-- openclaw-plugin-reference:manual-start -->

## Configuration

Path policy is configured under `plugins.entries.file-transfer.config.nodes`
in `openclaw.json`, keyed by node id, node display name, or `"*"`. Without a
matching entry every file operation is denied; `denyPaths` always wins over
allow entries.

`allowReadPaths` / `allowWritePaths` entries are matched with minimatch glob
semantics:

- A **directory entry must end in `/**`** to cover files inside it. A bare
  directory path (for example `/data`) matches only the literal directory
  itself: `dir_list` of `/data` succeeds while `file_fetch` of
  `/data/report.csv` is denied with `POLICY_DENIED`.
- A **bare file path** (for example `/data/config.json`) is an exact-file
  grant that covers only that file.
- `~` expands to the operator home directory.

Example:

```json validate=false
{
  "plugins": {
    "entries": {
      "file-transfer": {
        "config": {
          "nodes": {
            "*": {
              "allowReadPaths": ["~/Screenshots/**", "/tmp/**"],
              "allowWritePaths": ["~/Downloads/**"],
              "denyPaths": ["**/.ssh/**", "**/.aws/**"]
            }
          }
        }
      }
    }
  }
}
```

<!-- openclaw-plugin-reference:manual-end -->
