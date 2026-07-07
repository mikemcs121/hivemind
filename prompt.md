# AskUserQuestion prompt → thread UI layer (issue + fix reference)

Temporary working note for testing how Hivemind's chat UI layer shows an interactive
prompt (Claude Code's `AskUserQuestion` select menu) that the terminal underneath is
blocked on. Written 2026-07-06.

## The symptom

A thread's terminal showed an `AskUserQuestion` select menu (question + numbered
options, footer `Enter to select · ↑/↓ to navigate · Esc to cancel`), but the chat UI
layer drew nothing — no question card, no banner — and the thread status read
**✓ done** instead of **needs you**.

## Root cause

The question card rendered from the session transcript
(`~/.claude/projects/<encoded-dir>/<session>.jsonl`), but **Claude Code (v2.1.201)
does not flush an assistant message to the transcript until its tool resolves**.
`AskUserQuestion` resolves only when the human answers, so while the question is
pending — the entire window the card exists for — the JSONL ends at the user's
prompt with no assistant lines at all. The tool_use + tool_result only land *after*
the answer. Screen detection also missed it: `MENU_PATTERNS` keyed on "1. Yes / 2. No"
chrome, and AskUserQuestion options have arbitrary labels.

## The fix (src/renderer.js, 2026-07-06)

The visible terminal screen is the live source, like codex approvals:

- `SELECT_FOOTER_RE` — label-independent footer chrome (`Enter to
  select/submit/confirm … Esc to cancel`), added to `MENU_PATTERNS`, flips the pane
  to **needs you**.
- `parseScreenQuestion(screen)` — reconstructs header chip, question, options, and
  descriptions from the visible xterm screen.
- `syncScreenQuestion(pane)` — called from `probeAttention` (700ms while busy) and
  `evaluateIdle` (on quiet); renders a synthetic card keyed `screenq:<paneId>` via
  `addQuestionRow`, holding attention through `pendingQuestions`. Clicking an option
  sends its digit to the PTY (Claude select menus submit on digit).
- Lifecycle: menu leaves the screen → stand-in removed; the real transcript
  tool_use lands post-answer and supersedes the stand-in (guard at the top of
  `addQuestionRow`), rendering the permanent answered card with the recorded answer.

## How to re-test

1. Restart Hivemind (rebuilt renderer must be loaded).
2. In a Claude thread, send e.g.:
   `Call the AskUserQuestion tool exactly once with one question: header "Color",
   question "Which color do you want?", options "Red" and "Blue". Do nothing else,
   no other tools.`
3. Expect while pending: status **needs you**, banner with quick keys, a question
   card in the chat view with clickable options.
4. Click an option: the TUI answers, the card is replaced shortly after by the
   greyed answered card (from the transcript) showing the chosen answer.

Verified end-to-end 2026-07-06 with a real `claude --model haiku` thread driven over
CDP: pending card + attention while the transcript was silent, card click answered
the TUI, transcript card reconciled, `pendingQuestions` back to 0.

## Follow-up bug: multi-select card had no submit (fixed 2026-07-06)

Testing with a multi-select question (`options "Red", "Blue", "Orange", allow
multi select`) showed toggling worked but there was no way to submit. The Enter
button and multi-select hint existed in `addQuestionRow` but never rendered:
`parseScreenQuestion` detected multi-select only via "space to toggle" footer
text, which Claude Code's footer doesn't say. And `SCREEN_OPT_RE` only stripped
a checkbox *before* the option number, while the TUI draws it after
(`1. [√] Red` — `√` is the Windows fallback glyph for ✓), so raw `[√]` leaked
into the card labels.

Fix: checkboxes on option lines (either side of the number, including `√`) are
now the multi-select signal, are stripped from labels, and their checked state
drives the card's ☑ display — the screen is authoritative for screen-parsed
cards, so terminal-side toggles stay in sync. Re-test prompt:

`Call the AskUserQuestion tool exactly once with one question: header "Color",
question "Which colors do you want?", options "Red", "Blue" and "Orange",
multiSelect true. Do nothing else, no other tools.`

Expect: checkboxes on the card, toggles mirrored both ways, an **Enter** button
in the card footer that submits, then the transcript's answered card.

## Test-harness pitfalls (cost real time)

- **Never verify this with a shim that writes the JSONL immediately** — that's how
  the original bug shipped. Only a real claude run shows the deferred flush.
- Launching a test Electron **from inside a Claude Code session** leaks
  `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_ENTRYPOINT` into the thread PTYs; nested claude then runs as a child
  session and writes **no transcript at all** (looks exactly like a binding bug).
  Scrub those env vars before launching.
