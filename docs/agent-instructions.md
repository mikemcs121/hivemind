# Shared agent instructions and skills

AGENTS.md is the canonical project entry point. Keep architectural and subsystem
knowledge in docs/, and keep reusable procedures in .agents/skills/<name>/SKILL.md.
All agents use these same files; compatibility entry points contain only imports,
metadata, and links.

## Discovery

| Agent | Project rules | Skills |
|---|---|---|
| Codex | Reads root AGENTS.md | Discovers .agents/skills/ |
| Claude Code | CLAUDE.md imports ./AGENTS.md | .claude/skills/ wrappers read the canonical procedures |
| Gemini CLI | GEMINI.md imports ./AGENTS.md | Supports .agents/skills/ as a workspace skill directory |
| Grok Build | Supports AGENTS.md | Use the shared skill index and read the procedure directly; no Grok-specific skill folder is required |

These conventions apply to the documented CLIs. Other tools named "grok" may
differ. Any agent with repository file access can use the fallback prompt:

> Read AGENTS.md, then read and follow .agents/skills/verify/SKILL.md to verify this change.

Native discovery is a convenience, not a prerequisite for reading a procedure.
Agent permissions and available tools still apply. Keep repository facts here;
do not copy private account settings or global plugin skills into this project.

Sources checked September 2026:
[Codex skills](https://learn.chatgpt.com/docs/build-skills),
[Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[Claude imports](https://code.claude.com/docs/en/memory),
[Gemini imports](https://geminicli.com/docs/cli/gemini-md/),
[Gemini skills](https://geminicli.com/docs/cli/using-agent-skills/),
[Grok Build](https://x.ai/build).

## Hivemind's composer

Start a message with / to browse shared project skills. Selecting one expands it
into a plain instruction to read AGENTS.md if present and follow the selected
SKILL.md. Add task details and send normally. Selection itself does not submit.

Discovery checks .agents/skills/ first, then the active agent's legacy directory
(.claude/skills/ for Claude or .gemini/skills/ for Gemini). A skill folder needs
a real SKILL.md file and a lowercase name made of letters, digits, and hyphens.
The canonical skill wins when a legacy wrapper has the same name. Legacy
Claude skills keep their native slash invocation (and native argument handling).
Claude panes
also offer Claude built-ins and .claude/commands/*.md; built-ins retain precedence.

The chat composer is currently available for Claude and Codex. Gemini and Grok
remain terminal-only; use their native discovery or the fallback prompt there.
This migration does not add chat/transcript support for those agents.

discoverProjectCommands in src/renderer.js uses the existing guarded files.list
IPC. It never scans global agent homes. The composer shares pending reads,
caches for five seconds, and invalidates by project directory and active agent.
New skills appear on the next autocomplete refresh after expiry.

## Adding or updating a skill

1. Create .agents/skills/<name>/SKILL.md with YAML name and description fields.
   Describe its purpose, when to use it, the actual procedure, and any required
   capabilities. Use repository-relative commands and preserve task scope.
2. Link it from the skill table in AGENTS.md and the procedure index in
   docs/README.md. Link substantial supporting references from the skill, and
   read them only when relevant.
3. For Claude native discovery, add .claude/skills/<name>/SKILL.md with matching
   name/description and a link to the canonical procedure. Copy an existing
   wrapper as the pattern; do not duplicate the procedure.
4. Update the canonical procedure when behavior changes. If name or description
   changes, update wrapper metadata too. Keep agent-specific tool names out of
   the shared procedure unless the task actually requires that integration.

## Verification

Run: node --test scripts/test-agent-skills.cjs scripts/test-chat.cjs

The checks exercise shared/legacy discovery, duplicate precedence, incomplete
skills, missing directories, selection, switching agents, cache refresh, and
wrapper links/metadata. They do not prove a model followed the instructions.

For a new CLI or version, start a fresh session in this repository and ask:

> Identify the project instruction files and the paths of the verify and release skills. Do not run either procedure.

Expect the canonical paths above. Check native skill listings where available.
Use an isolated Hivemind profile for composer verification; do not restart the
user's live app just to reload project instructions.

Migration verification (September 2026): 24 focused skill/composer and chat
regression checks passed. Native Codex app-server discovery listed both canonical
skills. An isolated Electron instance verified shared file discovery through the
real guarded IPC, duplicate suppression, Claude/Codex picker choices, insertion,
and the Help entry. The Claude/Gemini imports and Claude wrapper targets were
checked on disk. Gemini and Grok were not installed, so their native session
discovery was not exercised. The bundled Python skill validator lacked PyYAML;
YAML metadata was parsed with the installed js-yaml library in the regression
checks instead. No release procedure was executed.
