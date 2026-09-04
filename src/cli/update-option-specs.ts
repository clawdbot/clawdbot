// Shared by Commander registration and command discovery before runtime bootstrap.
export const UPDATE_OPTION_SPECS: readonly [
  flags: string,
  description: string,
  defaultValue?: boolean,
][] = [
  ["--json", "Output result as JSON", false],
  ["--no-restart", "Skip restarting the gateway service after a successful update"],
  ["--dry-run", "Preview update actions without making changes", false],
  ["--channel <stable|extended-stable|beta|dev>", "Persist update channel (git + npm)"],
  [
    "--tag <dist-tag|version|spec>",
    "Override the package target for this update (dist-tag, version, or package spec)",
  ],
  ["--timeout <seconds>", "Timeout for each update step in seconds (default: 1800)"],
  ["--yes", "Skip confirmation prompts (non-interactive)", false],
  ["--accept-capabilities", "Accept widened plugin capabilities", false],
];
