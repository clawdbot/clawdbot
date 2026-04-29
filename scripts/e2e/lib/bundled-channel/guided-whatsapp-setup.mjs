#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2] || process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  throw new Error("missing package root");
}

const distDir = path.join(root, "dist");
const onboardChannelFiles = (await readdir(distDir))
  .filter((entry) => /^onboard-channels-.*\.js$/.test(entry))
  .toSorted();
let setupChannels;
for (const entry of onboardChannelFiles) {
  const module = await import(pathToFileURL(path.join(distDir, entry)));
  if (typeof module.setupChannels === "function") {
    setupChannels = module.setupChannels;
    break;
  }
}
if (!setupChannels) {
  throw new Error(
    `could not find packaged setupChannels export in ${JSON.stringify(onboardChannelFiles)}`,
  );
}

let channelSelectCount = 0;
const notes = [];
const prompter = {
  intro: async () => {},
  outro: async () => {},
  note: async (body, title) => {
    notes.push({ title, body });
  },
  confirm: async ({ message, initialValue }) => {
    if (message === "Link WhatsApp now (QR)?") {
      return false;
    }
    return initialValue ?? true;
  },
  select: async ({ message, options }) => {
    if (message === "Select a channel") {
      channelSelectCount += 1;
      return channelSelectCount === 1 ? "whatsapp" : "__done__";
    }
    if (message === "Install WhatsApp plugin?") {
      if (!options?.some((option) => option.value === "local")) {
        throw new Error(`missing bundled local install option: ${JSON.stringify(options)}`);
      }
      return "local";
    }
    if (message === "WhatsApp phone setup") {
      return "separate";
    }
    if (message === "WhatsApp DM policy") {
      return "disabled";
    }
    throw new Error(`unexpected select prompt: ${message}`);
  },
  multiselect: async ({ message }) => {
    throw new Error(`unexpected multiselect prompt: ${message}`);
  },
  text: async ({ message }) => {
    throw new Error(`unexpected text prompt: ${message}`);
  },
};
const runtime = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

const result = await setupChannels({ plugins: { enabled: true } }, runtime, prompter, {
  deferStatusUntilSelection: true,
  skipConfirm: true,
  skipStatusNote: true,
  skipDmPolicyPrompt: true,
  initialSelection: ["whatsapp"],
});

if (!result.channels?.whatsapp) {
  throw new Error(`WhatsApp setup did not write channel config: ${JSON.stringify(result)}`);
}
console.log("packaged guided WhatsApp setup completed");
