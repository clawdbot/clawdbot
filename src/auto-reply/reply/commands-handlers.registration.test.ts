import { describe, expect, it } from "vitest";
import { commandHandlerOrder } from "./commands-handlers.order.js";

describe("command handler registration", () => {
  it("registers built-in handlers in the runtime handler list", () => {
    expect(commandHandlerOrder).toContain("name");
    expect(commandHandlerOrder).toContain("login");
    expect(new Set(commandHandlerOrder).size).toBe(commandHandlerOrder.length);
  });

  it("keeps plugin text commands ahead of built-in /login", () => {
    expect(commandHandlerOrder.indexOf("plugin")).toBeLessThan(
      commandHandlerOrder.indexOf("login"),
    );
  });
});
