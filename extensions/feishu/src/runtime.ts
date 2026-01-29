import type { ClawdbotPluginRuntime } from "clawdbot/plugin-sdk";

type FeishuRuntime = ClawdbotPluginRuntime;

let _runtime: FeishuRuntime | undefined;

export function setFeishuRuntime(runtime: FeishuRuntime) {
    _runtime = runtime;
}

export function getFeishuRuntime(): FeishuRuntime {
    if (!_runtime) {
        throw new Error("Feishu runtime not initialized");
    }
    return _runtime;
}
