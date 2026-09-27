# Claude Code in o8

@AGENTS.md

Claude Code loads `AGENTS.md` only when no `CLAUDE.md` exists in the project or its ancestors, so
this file imports it. `AGENTS.md` is the canonical repository policy; this file adds only what is
specific to Claude Code and must not restate it.

- Treat hooks as safeguards, not proof. Preserve packet, worktree, approval, and operator gates in
  `AGENTS.md` even when a tool can technically bypass them.
