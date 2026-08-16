const LEGACY_TOOLS_MD_TEMPLATE =
  "# TOOLS.md - Local Notes\n\nSkills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup: camera names and locations, SSH hosts and aliases, preferred TTS voices, speaker/room names, device nicknames, anything environment-specific.\n\n## Examples\n\n```markdown\n### Cameras\n\n" +
  "- living-room → Main area, 180° wide angle\n- front-door → Entrance, motion-triggered\n\n### SSH\n\n- home-server → 192.168.1.100, user: admin\n\n### TTS\n\n" +
  '- Preferred voice: "Nova" (warm, slightly British)\n- Default speaker: Kitchen HomePod\n```\n\n## Why Separate?\n\n' +
  "Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.\n\n---\n\nAdd whatever helps you do your job. This is your cheat sheet.\n\n## Related\n\n- [Agent workspace](/concepts/agent-workspace)\n";

const LEGACY_TOOLS_DEV_MD_TEMPLATE =
  "# TOOLS.md - User Tool Notes (editable)\n\nThis file is for _your_ notes about external tools and conventions. It does not define which tools exist; OpenClaw provides built-in tools internally, and skills add the rest.\n\n## Examples\n\n### imsg\n\n" +
  "- Send an iMessage/SMS: describe who/what, confirm before sending.\n- Prefer short messages; avoid sending secrets.\n\n### sag\n\n" +
  "- Text-to-speech: specify voice, target speaker/room, and whether to stream.\n\nAdd whatever else you want the assistant to know about your local toolchain.\n\n## Related\n\n- [TOOLS.md template](/reference/templates/TOOLS)\n";
const LEGACY_TOOLS_DEV_FALLBACK =
  "# TOOLS.md - User Tool Notes (editable)\n\nAdd your local tool notes here.\n";

export function shouldMergeToolsMd(content: string): boolean {
  return (
    content.trim().length > 0 &&
    content !== LEGACY_TOOLS_MD_TEMPLATE &&
    content !== LEGACY_TOOLS_DEV_MD_TEMPLATE &&
    content !== LEGACY_TOOLS_DEV_FALLBACK
  );
}
