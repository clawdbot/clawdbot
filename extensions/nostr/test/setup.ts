// Test setup file for nostr extension
import { vi } from "vitest";

// Mock console.error to suppress noise in tests
vi.spyOn(console, "error").mockImplementation(() => {});
