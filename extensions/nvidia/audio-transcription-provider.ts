// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { NVIDIA_DEFAULT_ASR_MODEL, isNvidiaHostedAsrBaseUrl } from "./nvidia-speech-config.js";

export const nvidiaMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "nvidia",
  capabilities: ["audio"],
  defaultModels: { audio: NVIDIA_DEFAULT_ASR_MODEL },
  autoPriority: { audio: 55 },
  resolveAuth: ({ effectiveBaseUrl, providerConfig }) => {
    const configuredBaseUrl = effectiveBaseUrl ?? providerConfig?.baseUrl;
    const customConfiguredBaseUrl =
      typeof configuredBaseUrl === "string" &&
      configuredBaseUrl.trim() &&
      !isNvidiaHostedAsrBaseUrl(configuredBaseUrl)
        ? configuredBaseUrl
        : undefined;
    return customConfiguredBaseUrl ? { kind: "none", source: "nvidia-self-hosted" } : undefined;
  },
  transcribeAudio: async (req) => {
    const { transcribeNvidiaAudio } = await import("./nvidia-speech-http.runtime.js");
    return await transcribeNvidiaAudio(req);
  },
};
