# Clawdbot Browser Automation Architecture

## 1. Libraries Used
*   **Playwright (`playwright-core`)**: The primary engine for browser automation. Used for session management, page interactions (click, type, scroll), and capturing snapshots.
*   **Chromium**: The underlying browser instance managed by Playwright.
*   **Chrome DevTools Protocol (CDP)**: Used internally by Playwright and for specific low-level control where needed.
*   **Express**: Hosts the "Browser Bridge" server (`src/browser/bridge-server.ts`), exposing a REST API for the agent to control the browser instance.

## 2. Command Construction & Execution
The AI controls the browser through a structured tool definition and dispatch pipeline:

1.  **Tool Definition**: The `browser` tool is defined in `src/agents/tools/browser-tool.schema.ts` (using TypeBox). It exposes high-level actions like `navigate`, `act` (click/type/etc.), `snapshot`, and `screenshot`.
2.  **Tool Invocation**: The AI calls the tool with specific parameters (e.g., `action="act"`, `request={ kind: "click", ref: "42" }`).
3.  **Client Dispatch**:
    *   The tool implementation (`src/agents/tools/browser-tool.ts`) handles the request.
    *   It determines the target: **Host** (local) or **Node** (remote/sandbox).
    *   For **local execution**, it calls client functions in `src/browser/client-actions-core.ts`.
4.  **Bridge Request**: The client sends an HTTP POST request to the local Bridge Server (e.g., `POST /act`).
5.  **Execution**: The Bridge Server receives the request and executes the corresponding Playwright command (e.g., `page.click()`) on the active browser page.

## 3. "Device Nodes" Architecture
Clawdbot uses a distributed architecture to control browsers across different environments (local machine, Docker sandbox, or remote devices).

*   **Node Registry**: `src/gateway/node-registry.ts` tracks connected nodes and their capabilities (e.g., `caps: ["browser"]`).
*   **Proxying**:
    *   When the AI targets a remote node (e.g., `target="node"`), the tool uses `callBrowserProxy`.
    *   This sends a `node.invoke` event to the Gateway with the command `browser.proxy`.
    *   The Gateway forwards this event to the target node via WebSocket.
*   **Node Execution**:
    *   The target node (running `src/node-host/runner.ts`) receives the `node.invoke` event.
    *   It handles the `browser.proxy` command by dispatching it to its *own* local browser control service.
    *   This effectively allows any running Clawdbot instance to act as a remote browser driver for the main agent.
