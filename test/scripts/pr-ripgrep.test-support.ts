// PR fixtures need only these grep-compatible flags, including real non-match exits.
// Keep their shell functions and executable PATH entry independent of host ripgrep.
export const PR_RIPGREP_COMMAND = [
  'if [ "${1-}" = "-F" ]; then',
  "  shift",
  '  command grep -F "$@"',
  "else",
  '  command grep -E "$@"',
  "fi",
].join("\n");
