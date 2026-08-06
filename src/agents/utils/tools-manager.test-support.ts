import "./tools-manager.js";

type ToolsManagerTestApi = {
  testing: {
    downloadFile(url: string, dest: string, maxBytes: number): Promise<void>;
  };
};

function getTestApi(): ToolsManagerTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.toolsManagerTestApi")
  ] as ToolsManagerTestApi;
}

export const testing = getTestApi().testing;
