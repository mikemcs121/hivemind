# Chat verification — 2026-09-04

Tested in an isolated `HM_USER_DATA` profile with the repository's Electron
runtime and installed Claude Code 2.1.261. The user's live application and threads
were not restarted. Changes are renderer-only and require a window reload to
appear in an already-running instance.

## Findings and fixes

- A normal answer ending “Would you like to continue?” set `attention`, locked
  the composer, and prevented the delayed Enter from submitting a follow-up.
  Composer and submission guards now distinguish a blocking CLI interaction
  from a prose question. Live approvals still block ordinary prompt submission.
- The installed Claude version can write AskUserQuestion before it is answered.
  Treating that entry as completion could remove the live menu card, or display
  both transcript and screen cards. Only the tool result now supersedes the live
  card; transcript batches reconcile the screen even when terminal output is quiet.
- Custom answers, unfamiliar menus, sign-in, missing transcripts, and stalled
  prompts previously required switching to the terminal view. **Interact** now
  embeds the same live xterm beneath the conversation; **Done** restores the
  composer. Custom-answer menu options open it automatically. Ctrl+F opens it
  with the search field focused. This exposes native CLI controls inside chat;
  it does not translate every possible CLI screen into a structured card.
- Generic prompt quick keys reject clicks when the screen changed since rendering.

## Live checks that passed

| Prompt or action | Verified outcome |
|---|---|
| Request a Markdown table and fenced JavaScript example, ending with “Would you like to continue?” | Table and code render; composer remains usable |
| Reply “Yes” and request `FOLLOWUP_OK` followed by a color question | Agent receives follow-up; one live question card appears |
| Click Green | Agent confirms Green; answered record appears in chat |
| Ask for Search, Export, Alerts with multiSelect enabled | Two choices reflect live checkbox state; Review and Submit send Search and Export |
| Ask for Cat/Dog, choose Type something, type Parrot with browser keyboard input | Interact opens and receives focus; agent confirms Parrot; Done restores composer |
| Attach a fixture containing `ATTACHMENT_OK_7391`, send a multiline prompt requesting its contents | Attachment chip, user message, Bash tool/result, file contents, and `MULTILINE_OK` render |
| Send `/help`, operate the CLI with Escape, close Interact | CLI screen is visible inside chat; chat remains the selected view |
| Ctrl+F from the chat composer | Interact and search open; search retains keyboard focus |
| Reduce pane to approximately 430 CSS pixels wide | Interact remains visible; chat has no horizontal overflow |

Screenshots of the normal conversation and custom-answer panel were inspected.
The live test scripts and screenshots remain under `.hivemind/chat-verify/` as
local test artifacts.

## Repeatable regression checks and limits

Run `node --test scripts/test-chat.cjs`: **13 tests passed**. These cover prose
follow-up submission, Enter retries, approval and authentication locks, a menu
appearing during paste, respawn cancellation, early transcript question timing,
and a Codex command-approval fixture retaining its command and reason.

`node --check src/renderer.js` and `git diff --check` also passed.

Live provider testing was Claude only. Codex approval rendering was checked with
a fixture, not a signed-in Codex session. Full sign-in, image clipboard input,
plan approval/revision, interruptions, and all provider-specific CLI screens were
not exhaustively exercised. Interact preserves access to the underlying CLI for
these cases; this report does not claim exhaustive terminal parity testing.
