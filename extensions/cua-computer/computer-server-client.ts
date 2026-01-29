/**
 * HTTP client for communicating with cua-computer-server.
 *
 * computer-server provides desktop automation capabilities via HTTP POST /cmd endpoint.
 * Each command returns { success: boolean, ...result } or { success: false, error: string }.
 *
 * Note: computer-server also exposes an MCP interface at /mcp which could be used
 * if Clawdbot adds MCP client support in the future.
 *
 * @see https://github.com/trycua/cua/tree/main/libs/python/computer-server
 */

export interface ComputerServerConfig {
  /** Base URL of the computer-server (default: http://localhost:8000) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

export interface ScreenshotResult {
  /** Base64-encoded PNG image data */
  imageData: string;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface CursorPosition {
  x: number;
  y: number;
}

export interface CommandResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export class ComputerServerError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ComputerServerError";
  }
}

export class ComputerServerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ComputerServerConfig = {}) {
    this.baseUrl = config.baseUrl ?? "http://localhost:8000";
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  /**
   * Take a screenshot of the desktop.
   * @returns Base64-encoded PNG image data
   */
  async screenshot(): Promise<ScreenshotResult> {
    const result = await this.call("screenshot");
    return { imageData: result.image_data as string };
  }

  /**
   * Get the screen dimensions.
   */
  async getScreenSize(): Promise<ScreenSize> {
    const result = await this.call("get_screen_size");
    const size = result.size as { width: number; height: number };
    return {
      width: size.width,
      height: size.height,
    };
  }

  /**
   * Get the current cursor position.
   */
  async getCursorPosition(): Promise<CursorPosition> {
    const result = await this.call("get_cursor_position");
    const position = result.position as { x: number; y: number };
    return {
      x: position.x,
      y: position.y,
    };
  }

  /**
   * Perform a left click at the specified coordinates.
   * If coordinates are omitted, clicks at the current cursor position.
   */
  async click(x?: number, y?: number): Promise<void> {
    await this.call("left_click", { x, y });
  }

  /**
   * Perform a double click at the specified coordinates.
   */
  async doubleClick(x?: number, y?: number): Promise<void> {
    await this.call("double_click", { x, y });
  }

  /**
   * Perform a right click at the specified coordinates.
   */
  async rightClick(x?: number, y?: number): Promise<void> {
    await this.call("right_click", { x, y });
  }

  /**
   * Move the cursor to the specified coordinates.
   */
  async moveCursor(x: number, y: number): Promise<void> {
    await this.call("move_cursor", { x, y });
  }

  /**
   * Type text using the keyboard.
   */
  async type(text: string): Promise<void> {
    await this.call("type_text", { text });
  }

  /**
   * Press a single key (e.g., "Return", "Tab", "Escape").
   */
  async key(key: string): Promise<void> {
    await this.call("press_key", { key });
  }

  /**
   * Press a combination of keys (e.g., ["cmd", "c"] for copy).
   */
  async hotkey(keys: string[]): Promise<void> {
    await this.call("hotkey", { keys });
  }

  /**
   * Scroll in a direction.
   * @param direction - "up", "down", "left", or "right"
   * @param clicks - Number of scroll clicks (default: 1)
   */
  async scroll(direction: "up" | "down" | "left" | "right", clicks = 1): Promise<void> {
    if (direction === "down") {
      await this.call("scroll_down", { clicks });
    } else if (direction === "up") {
      await this.call("scroll_up", { clicks });
    } else {
      // Horizontal scroll: use scroll(x, y) where positive x = right, negative = left
      const x = direction === "right" ? 300 * clicks : -300 * clicks;
      await this.call("scroll", { x, y: 0 });
    }
  }

  /**
   * Drag from current position to target coordinates.
   */
  async dragTo(x: number, y: number, button = "left", duration = 0.5): Promise<void> {
    await this.call("drag_to", { x, y, button, duration });
  }

  /**
   * Check if the computer-server is available and responding.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/status`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Send a command to the computer-server.
   */
  private async call(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<CommandResult> {
    // Filter out undefined values from params
    const filteredParams = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined),
    );

    const response = await fetch(`${this.baseUrl}/cmd`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command, params: filteredParams }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new ComputerServerError(
        `HTTP ${response.status}: ${response.statusText}`,
        command,
        response.status,
      );
    }

    // The /cmd endpoint returns SSE-style "data: {...}\n\n" format
    const text = await response.text();
    const jsonMatch = text.match(/^data:\s*(.+)$/m);
    if (!jsonMatch) {
      throw new ComputerServerError(`Invalid response format from computer-server`, command);
    }

    const result = JSON.parse(jsonMatch[1]) as CommandResult;

    if (!result.success) {
      throw new ComputerServerError(result.error ?? `Command '${command}' failed`, command);
    }

    return result;
  }
}
