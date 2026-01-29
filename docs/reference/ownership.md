# Architecture & Code Ownership Map

This map defines the primary domains and their respective owners within the Clawdbot codebase.

| Domain | Scope | Primary Entrypoint | Owner |
| :--- | :--- | :--- | :--- |
| **CLI** | `src/cli/` | `src/entry.ts` | CLI Team |
| **Gateway** | `src/gateway/` | `src/gateway/server.impl.ts` | Core Infra |
| **Agent Runner** | `src/agents/` | `src/agents/pi-embedded-runner.ts` | AI Logic |
| **Channels** | `src/channels/`, `src/web/` | `src/gateway/server-channels.ts` | Messaging |
| **Extensions** | `extensions/` | `extensions/*/index.ts` | Plugins |
| **Mobile Apps** | `apps/ios/`, `apps/android/` | N/A | Mobile Team |
| **Mac App** | `apps/macos/` | N/A | Desktop Team |

## Entrypoints for Exploration

- **Initialize Logic**: `src/entry.ts` -> `src/cli/run-main.ts` -> `src/cli/program.ts`
- **Main Server**: `src/gateway/server.impl.ts` (Gateway initialization)
- **Message Flow**: `src/gateway/server-chat.ts` (Routing incoming to agent)
- **Agent Loop**: `src/agents/pi-embedded-runner/run.ts`
