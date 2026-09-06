const COMMON_VERSION_MANAGER_MARKERS = [
  "/.nvm/",
  "/.fnm/",
  "/.local/share/fnm/",
  "/.volta/",
  "/.asdf/",
  "/.n/",
  "/.nodenv/",
  "/.nodebrew/",
  "/nvs/",
];

// Callers own normalization and case handling; the profiles preserve their
// distinct CA-discovery, executable-selection, and service PATH policies.
export function matchesVersionManagerPath(
  path: string,
  profile: "linux-ca" | "daemon-runtime" | "service-path",
): boolean {
  return (
    COMMON_VERSION_MANAGER_MARKERS.some((marker) => path.includes(marker)) ||
    (profile !== "service-path" && path.includes("/.local/share/mise/")) ||
    (profile === "linux-ca" && path.includes("/.nvs/")) ||
    (profile === "daemon-runtime" && path.includes("/library/application support/fnm/"))
  );
}
