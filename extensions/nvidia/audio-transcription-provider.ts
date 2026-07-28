// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { NVIDIA_DEFAULT_ASR_MODEL, isNvidiaHostedAsrBaseUrl } from "./nvidia-speech-config.js";

export const nvidiaMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "nvidia",
  capabilities: ["audio"],
  defaultModels: { audio: NVIDIA_DEFAULT_ASR_MODEL },
  autoPriority: { audio: 55 },
  resolveAuth: ({ providerConfig }) => {
    const configuredBaseUrl = providerConfig?.baseUrl;
    const envBaseUrl = process.env.NVIDIA_ASR_BASE_URL?.trim();
    const customBaseUrl =
      (typeof configuredBaseUrl === "string" && configuredBaseUrl.trim()
        ? configuredBaseUrl
        : undefined) ?? envBaseUrl;
    return customBaseUrl && !isNvidiaHostedAsrBaseUrl(customBaseUrl)
      ? { kind: "none", source: "nvidia-self-hosted" }
      : undefined;
  },
  transcribeAudio: async (req) => {
    const { transcribeNvidiaAudio } = await import("./nvidia-speech-http.runtime.js");
    return await transcribeNvidiaAudio(req);
  },
};
