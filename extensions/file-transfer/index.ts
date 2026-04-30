import {
  definePluginEntry,
  type OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import { handleDirFetch } from "./src/node-host/dir-fetch.js";
import { handleDirList } from "./src/node-host/dir-list.js";
import { handleFileFetch } from "./src/node-host/file-fetch.js";
import { handleFileWrite } from "./src/node-host/file-write.js";
import { createFileTransferNodeInvokePolicy } from "./src/shared/node-invoke-policy.js";
import { createDirFetchTool } from "./src/tools/dir-fetch-tool.js";
import { createDirListTool } from "./src/tools/dir-list-tool.js";
import { createFileFetchTool } from "./src/tools/file-fetch-tool.js";
import { createFileWriteTool } from "./src/tools/file-write-tool.js";

const fileTransferNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  {
    command: "file.fetch",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = paramsJSON ? JSON.parse(paramsJSON) : {};
      const result = await handleFileFetch(params);
      return JSON.stringify(result);
    },
  },
  {
    command: "dir.list",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = paramsJSON ? JSON.parse(paramsJSON) : {};
      const result = await handleDirList(params);
      return JSON.stringify(result);
    },
  },
  {
    command: "dir.fetch",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = paramsJSON ? JSON.parse(paramsJSON) : {};
      const result = await handleDirFetch(params);
      return JSON.stringify(result);
    },
  },
  {
    command: "file.write",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = paramsJSON ? JSON.parse(paramsJSON) : {};
      const result = await handleFileWrite(params);
      return JSON.stringify(result);
    },
  },
];

export default definePluginEntry({
  id: "file-transfer",
  name: "File Transfer",
  description: "Fetch, list, and write files on paired nodes via dedicated node commands.",
  nodeHostCommands: fileTransferNodeHostCommands,
  register(api) {
    api.registerNodeInvokePolicy(createFileTransferNodeInvokePolicy());
    api.registerTool(createFileFetchTool());
    api.registerTool(createDirListTool());
    api.registerTool(createDirFetchTool());
    api.registerTool(createFileWriteTool());
  },
});
