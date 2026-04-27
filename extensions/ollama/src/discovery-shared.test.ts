import { describe, expect, it } from "vitest";
import { isLocalOllamaBaseUrl } from "./discovery-shared.js";

describe("isLocalOllamaBaseUrl", () => {
  it.each([
    undefined,
    "",
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://0.0.0.0:11434",
    "http://[::1]:11434",
    "http://10.0.0.5:11434",
    "http://172.16.0.10:11434",
    "http://172.31.255.254:11434",
    "http://192.168.1.100:11434",
    "http://gpu-node-1:11434",
    "http://mac-studio.local:11434",
    "http://[fd00::1]:11434",
    "http://[fe90::1]:11434",
  ])("classifies %s as local", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(true);
  });

  it.each([
    "https://ollama.com",
    "https://api.ollama.com/v1",
    "https://ollama.example.com:11434",
    "http://8.8.8.8:11434",
    "http://172.15.255.254:11434",
    "http://172.32.0.1:11434",
    "http://193.168.1.1:11434",
    "http://[2001:4860:4860::8888]:11434",
    "http://10.example.com:11434",
    "not a url",
  ])("classifies %s as remote", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(false);
  });
});
