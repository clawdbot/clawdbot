import { clearCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";

let clearPluginMetadataProcessMemo: (() => void) | undefined;

export function registerPluginMetadataProcessMemoLifecycleClear(
  clearProcessMemo: () => void,
): void {
  clearPluginMetadataProcessMemo = clearProcessMemo;
}

export function clearPluginMetadataLifecycleCaches(): void {
  clearCurrentPluginMetadataSnapshotState();
  clearPluginMetadataProcessMemo?.();
}
