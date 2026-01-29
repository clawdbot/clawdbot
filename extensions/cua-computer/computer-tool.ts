/**
 * Computer tool for GUI automation via cua-computer-server.
 *
 * Enables agents to take screenshots, click, type, scroll, and perform
 * other desktop automation actions on sandboxes or nodes running computer-server.
 *
 * @see https://github.com/trycua/cua/tree/main/libs/python/computer-server
 */

import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../src/config/config.js";
import { stringEnum } from "../../src/agents/schema/typebox.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { imageResult, jsonResult, readNumberParam, readStringParam } from "../../src/agents/tools/common.js";
import { ComputerServerClient, ComputerServerError } from "./computer-server-client.js";

const COMPUTER_ACTIONS = [
  "screenshot",
  "click",
  "double_click",
  "right_click",
  "type",
  "key",
  "hotkey",
  "scroll",
  "move",
  "drag",
  "get_screen_size",
  "get_cursor_position",
] as const;

const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

const ComputerToolSchema = Type.Object({
  action: stringEnum(COMPUTER_ACTIONS, {
    description:
      "Action to perform: screenshot, click, double_click, right_click, type, key, hotkey, scroll, move, drag, get_screen_size, get_cursor_position",
  }),

  // Coordinates (for click, double_click, right_click, move, scroll)
  x: Type.Optional(Type.Number({ description: "X coordinate in pixels" })),
  y: Type.Optional(Type.Number({ description: "Y coordinate in pixels" })),

  // Typing
  text: Type.Optional(Type.String({ description: "Text to type (for 'type' action)" })),

  // Key press
  key: Type.Optional(
    Type.String({
      description: "Key to press (for 'key' action), e.g., 'Return', 'Tab', 'Escape'",
    }),
  ),

  // Hotkey
  keys: Type.Optional(
    Type.Array(Type.String(), {
      description: "Keys for hotkey combination (for 'hotkey' action), e.g., ['cmd', 'c']",
    }),
  ),

  // Scroll
  direction: Type.Optional(
    stringEnum(SCROLL_DIRECTIONS, {
      description: "Scroll direction (for 'scroll' action): up, down, left, right",
    }),
  ),
  amount: Type.Optional(
    Type.Number({
      description: "Scroll amount in clicks (for 'scroll' action), default: 1",
    }),
  ),

  // Drag
  end_x: Type.Optional(Type.Number({ description: "End X coordinate for drag action" })),
  end_y: Type.Optional(Type.Number({ description: "End Y coordinate for drag action" })),

  // Connection
  computer_server_url: Type.Optional(
    Type.String({
      description:
        "URL of the computer-server (default: http://localhost:8000). Usually set automatically based on sandbox/node configuration.",
    }),
  ),
});

export type ComputerToolOptions = {
  /** Default computer-server URL */
  defaultServerUrl?: string;
  /** Clawdbot configuration */
  config?: ClawdbotConfig;
};

export function createComputerTool(options?: ComputerToolOptions): AnyAgentTool {
  return {
    label: "Computer",
    name: "computer",
    description: `Control a computer's GUI - take screenshots, click, type, scroll, and more.

Use this tool to interact with desktop applications running in a sandbox or on a connected node.

**Actions:**
- \`screenshot\`: Capture the current screen state. Always do this first to see what's on screen.
- \`click\`: Left-click at coordinates (x, y)
- \`double_click\`: Double-click at coordinates (x, y)
- \`right_click\`: Right-click at coordinates (x, y)
- \`type\`: Type text at the current cursor position
- \`key\`: Press a single key (e.g., "Return", "Tab", "Escape")
- \`hotkey\`: Press a key combination (e.g., ["cmd", "c"] for copy)
- \`scroll\`: Scroll in a direction (up, down, left, right)
- \`move\`: Move cursor to coordinates without clicking
- \`drag\`: Drag from (x, y) to (end_x, end_y)
- \`get_screen_size\`: Get screen dimensions
- \`get_cursor_position\`: Get current cursor position

**Tips:**
- Always take a screenshot first to understand the current screen state
- Use coordinates from screenshots to click on UI elements
- After performing actions, take another screenshot to verify the result`,
    parameters: ComputerToolSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params as Record<string, unknown>, "action", {
        required: true,
      });
      const serverUrl =
        readStringParam(params as Record<string, unknown>, "computer_server_url") ??
        options?.defaultServerUrl ??
        "http://localhost:8000";

      const client = new ComputerServerClient({ baseUrl: serverUrl });

      try {
        switch (action) {
          case "screenshot": {
            const result = await client.screenshot();
            return await imageResult({
              label: "Screenshot",
              path: "screenshot.png",
              base64: result.imageData,
              mimeType: "image/png",
              extraText: "Screenshot captured successfully",
            });
          }

          case "click": {
            const x = readNumberParam(params as Record<string, unknown>, "x");
            const y = readNumberParam(params as Record<string, unknown>, "y");
            await client.click(x, y);
            return jsonResult({
              success: true,
              action: "click",
              coordinates: x !== undefined && y !== undefined ? { x, y } : "current position",
            });
          }

          case "double_click": {
            const x = readNumberParam(params as Record<string, unknown>, "x");
            const y = readNumberParam(params as Record<string, unknown>, "y");
            await client.doubleClick(x, y);
            return jsonResult({
              success: true,
              action: "double_click",
              coordinates: x !== undefined && y !== undefined ? { x, y } : "current position",
            });
          }

          case "right_click": {
            const x = readNumberParam(params as Record<string, unknown>, "x");
            const y = readNumberParam(params as Record<string, unknown>, "y");
            await client.rightClick(x, y);
            return jsonResult({
              success: true,
              action: "right_click",
              coordinates: x !== undefined && y !== undefined ? { x, y } : "current position",
            });
          }

          case "type": {
            const text = readStringParam(params as Record<string, unknown>, "text", {
              required: true,
              label: "text",
            });
            await client.type(text);
            return jsonResult({
              success: true,
              action: "type",
              text,
            });
          }

          case "key": {
            const key = readStringParam(params as Record<string, unknown>, "key", {
              required: true,
              label: "key",
            });
            await client.key(key);
            return jsonResult({
              success: true,
              action: "key",
              key,
            });
          }

          case "hotkey": {
            const keys = params.keys as string[] | undefined;
            if (!keys || !Array.isArray(keys) || keys.length === 0) {
              throw new Error("keys array required for hotkey action");
            }
            await client.hotkey(keys);
            return jsonResult({
              success: true,
              action: "hotkey",
              keys,
            });
          }

          case "scroll": {
            const direction = readStringParam(params as Record<string, unknown>, "direction", {
              required: true,
              label: "direction",
            }) as "up" | "down" | "left" | "right";
            const amount = readNumberParam(params as Record<string, unknown>, "amount") ?? 1;
            await client.scroll(direction, amount);
            return jsonResult({
              success: true,
              action: "scroll",
              direction,
              amount,
            });
          }

          case "move": {
            const x = readNumberParam(params as Record<string, unknown>, "x", {
              required: true,
              label: "x coordinate",
            })!;
            const y = readNumberParam(params as Record<string, unknown>, "y", {
              required: true,
              label: "y coordinate",
            })!;
            await client.moveCursor(x, y);
            return jsonResult({
              success: true,
              action: "move",
              coordinates: { x, y },
            });
          }

          case "drag": {
            const x = readNumberParam(params as Record<string, unknown>, "x", {
              required: true,
              label: "start x coordinate",
            })!;
            const y = readNumberParam(params as Record<string, unknown>, "y", {
              required: true,
              label: "start y coordinate",
            })!;
            const endX = readNumberParam(params as Record<string, unknown>, "end_x", {
              required: true,
              label: "end x coordinate",
            })!;
            const endY = readNumberParam(params as Record<string, unknown>, "end_y", {
              required: true,
              label: "end y coordinate",
            })!;
            // Move to start position first, then drag
            await client.moveCursor(x, y);
            await client.dragTo(endX, endY);
            return jsonResult({
              success: true,
              action: "drag",
              from: { x, y },
              to: { x: endX, y: endY },
            });
          }

          case "get_screen_size": {
            const size = await client.getScreenSize();
            return jsonResult({
              success: true,
              action: "get_screen_size",
              width: size.width,
              height: size.height,
            });
          }

          case "get_cursor_position": {
            const pos = await client.getCursorPosition();
            return jsonResult({
              success: true,
              action: "get_cursor_position",
              x: pos.x,
              y: pos.y,
            });
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        if (error instanceof ComputerServerError) {
          return jsonResult({
            success: false,
            error: error.message,
            command: error.command,
          });
        }
        throw error;
      }
    },
  };
}
