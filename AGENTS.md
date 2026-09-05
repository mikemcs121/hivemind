# Hivemind

Shared project instructions for every coding agent working in this repository.
Hivemind is an Electron app for running Claude Code, Codex, Gemini, and Grok
threads against project directories.

## Before changing code

Read [docs/README.md](docs/README.md), then the architecture, development, and
subsystem docs it routes you to. Read only the skills relevant to the task.
Run commands from the repository root unless a procedure says otherwise.

- If a change makes a doc in `docs/` inaccurate, update that doc in the same change.
- Never kill the user's live Hivemind instance or kill Electron processes by name.
  Test with an isolated `HM_USER_DATA` instance; see the `verify` skill.
- Main-process changes need a full app relaunch to test; renderer changes need
  a window reload.
- Other agent threads may edit this repo concurrently. Check `git status` and
  re-read files before editing; preserve unrelated changes.
- Before building a portable release, follow the `release` skill, including the
  version bump required by the updater.

## Keep Help in sync

Whenever a change makes the in-app Help inaccurate (a user-facing feature,
keyboard shortcut, button, or voice/settings behavior), update `#help-modal`
in `src/index.html` in the same change. The Hivemind commands list is generated
from `HM_COMMANDS[].help`; update that registry entry for generated help.

## Shared skills

The canonical procedures live in `.agents/skills/`:

| Skill | When to use | Instructions |
|---|---|---|
| verify | Verify non-trivial renderer/main changes in an isolated app instance | [.agents/skills/verify/SKILL.md](.agents/skills/verify/SKILL.md) |
| release | Build and publish a Hivemind portable release when requested | [.agents/skills/release/SKILL.md](.agents/skills/release/SKILL.md) |

If your agent does not discover skills automatically, read the linked file and
follow its procedure using your available tools. Paths in a skill's commands
are relative to the repository root unless stated otherwise. Preserve the
user's task scope and existing authorization; loading a skill does not itself
authorize publishing a release.

Maintain shared rules here, subsystem knowledge in `docs/`, and procedures in
the canonical skill files. `CLAUDE.md`, `GEMINI.md`, and `.claude/skills/` are
compatibility entry points, not separate copies of project rules or procedures.
See [docs/agent-instructions.md](docs/agent-instructions.md) for discovery,
adding skills, and checking an agent's setup.
