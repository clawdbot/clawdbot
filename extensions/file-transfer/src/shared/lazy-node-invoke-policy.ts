import type { OpenClawPluginNodeInvokePolicy } from "openclaw/plugin-sdk/plugin-entry";
import { FILE_TRANSFER_NODE_INVOKE_COMMANDS } from "./node-invoke-policy-commands.js";

type LoadFileTransferNodeInvokePolicy = () => Promise<OpenClawPluginNodeInvokePolicy>;

const loadFileTransferNodeInvokePolicy: LoadFileTransferNodeInvokePolicy = async () => {
  const { createFileTransferNodeInvokePolicy } = await import("./node-invoke-policy.js");
  return createFileTransferNodeInvokePolicy();
};

export function createLazyFileTransferNodeInvokePolicy(
  loadPolicy: LoadFileTransferNodeInvokePolicy = loadFileTransferNodeInvokePolicy,
): OpenClawPluginNodeInvokePolicy {
  let policyPromise: Promise<OpenClawPluginNodeInvokePolicy> | undefined;

  return {
    commands: [...FILE_TRANSFER_NODE_INVOKE_COMMANDS],
    async handle(ctx) {
      let policy: OpenClawPluginNodeInvokePolicy;
      try {
        policyPromise ??= loadPolicy();
        policy = await policyPromise;
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : String(error);
        return {
          ok: false,
          code: "PLUGIN_POLICY_UNAVAILABLE",
          message: `file-transfer PLUGIN_POLICY_UNAVAILABLE: node.invoke policy unavailable: ${message}`,
          unavailable: true,
        };
      }
      return await policy.handle(ctx);
    },
  };
}
