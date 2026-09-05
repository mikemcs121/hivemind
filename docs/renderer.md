# Renderer / UI subsystem

Documentation of `src/renderer.js`, `src/index.html`, and `src/styles.css` — the entire
Electron renderer process. Written for future agents extending the UI.

## Purpose

The renderer owns everything visible: the sidebar (hive list + docked panels), the
thread grid (xterm.js terminals + chat overlays), all modals, keyboard shortcuts,
themes, voice dictation, and the "Hivemind command" natural-language layer. It is a
**single ~10,100-line vanilla-JS file** (`src/renderer.js`) loaded by `src/index.html`
— no framework, no bundler, no modules. State lives in top-level `let`/`const`
variables; DOM is built with `document.createElement` or `innerHTML` on
pre-existing elements from `index.html`.

The renderer never touches Node APIs directly. Everything OS/process-shaped (PTYs,
git, filesystem, transcripts, notifications, spell check, builds) goes through the
`window.api.*` context bridge defined in `preload.js` and implemented in `main.js`
and its helper modules (`git.js`, `files.js`, `transcript.js`, `plan.js`,
`promptHistory.js`, `build.js`, …).

Terminology: a **board** ≡ a **hive** (a project directory); a **pane** ≡ a
**thread** (one agent CLI running in one terminal). The code says board/pane, the
UI says hive/thread.

## File map of renderer.js

> **Line numbers drift with every edit — treat them as approximate. The stable
> anchors are the function/variable names; grep for those.** Ranges below are from
> the 10,142-line version at the time of writing. The file is organized in
> commented sections (`// ----- Section name -----`); searching for the section
> name in a comment also works.

| ~Lines | Region | Key symbols |
|---|---|---|
| 1–28 | Top-level state; Claude session-id helpers | `boards`, `activeBoardId`, `grids` (Map boardId→grid), `nextId`, `SESSION_ID_RE`, `isSessionId`, `newSessionId` |
| 30–185 | **Themes** — registry colours both CSS vars and xterm palette | `THEMES`, `DEFAULT_THEME`, `currentTheme`, `THEME` (mutated in place), `applyTheme` |
| 186–214 | Per-thread font sizing | `FONT_MIN/MAX/DEFAULT`, `clampFont`, `defaultFontSize`, `setPaneFontSize` |
| 215–251 | Claude model fallbacks + API list prices (cost chip) | `MODELS`, `defaultModel`, `MODEL_PRICES`, `priceForModel` |
| 253–305 | Codex and Grok model fallbacks/defaults | `CODEX_MODELS`, `CODEX_MODELS_BY_ACCOUNT`, `GROK_MODELS`, `defaultCodexModel`, `defaultGrokModel` |
| (after the models) | **ChatGPT accounts** — the list is owned by the main process; only the default-for-new-threads is local | `codexAccounts`, `defaultCodexAccount`, `isValidCodexAccount`, `codexAccountFor`, `codexAccountDetail`, `fillCodexAccountSelect`, `refreshCodexAccounts` |
| 297–450 | **Agents** (claude/codex/gemini/grok) + per-pane setters | `AGENTS`, `agentFor`, `paneCommand`, `setPaneAgent`, `respawnPane`, `setPaneModel`, `setPaneCodexModel`, `setPaneGrokModel`, `setPaneCodexAccount`, `paintCodexAccountSelect`, `paintPermSelect`, `setPanePerm`, `restartForPerm`, `applyPendingPerm` |
| 500–540 | **Live permission mode** — reads the footer hint back into the dropdown | `PERM_SCREEN_RE`, `PERM_SCREEN_MODES`, `PERM_SETTLE_MS`, `permScreenCheck` |
| 542–545+ | **Terminal status detection** constants | `IDLE_MS`, `STATE_LABEL`, `paneStatusLabel`, `SELECT_FOOTER_RE`, `REVIEW_PROMPT_RE`, `MENU_PATTERNS`, `QUESTION_PATTERNS`, `ERROR_PATTERNS`, `AUTH_PATTERNS`, `CMD_MISSING_PATTERNS`, `stripAnsi`, `screenText`, `joinWrapped`, `menuOnScreen`, `authPromptOnScreen`, `authTextFrom`, `promptVisibleOnScreen`, `PROBE_MS`, `chatHasPendingQuestion`, `syncQuestionExpiry` |
| 547–843 | Screen-parsed question cards + attention probe | `stripBoxChrome`, `testWrapped`, `parseScreenQuestion`, `parseScreenReview`, `parsePlanScreenQuestion`, `parseCodexApproval`, `syncScreenQuestion`, `cardMenuLive`, `removeScreenQuestion`, `probeAttention`, `startAttentionProbe`, `stopAttentionProbe` |
| 845–978 | **Pane state machine** (busy/idle/attention/error/dead) | `markActivity`, `evaluateIdle`, `setDoneGlow`, `setNeedsAuth`, `setPaneState`, `notify` |
| 980–1020 | Sidebar per-board status dots/badges | `boardStatus`, `updateBoardStatus` |
| 1022–1103 | Thread captions (rebuilt from keystrokes) | `feedCaptionInput`, `REPLY_WORDS`, `isReplyLike`, `commitCaption`, `setPaneCaption`, `sendToPane` |
| 1105–1170 | Prompt delivery to a PTY — bracketed paste, size-scaled Enter delay, screen-verified Enter retry when the submit gets swallowed as part of the paste burst, opt-out of caption tracking (`{ caption: false }`) for Hivemind-composed prompts | `typePrompt`, `SUBMIT_RETRY_MS`, `confirmSubmit`, `deliverPrompt` |
| (after prompt delivery) | **Thread handoff** — pass a conversation to another thread: ask the source thread for a brief at `.hivemind/handoffs/<id>.md`, poll until it settles, then point the target at it (see `docs/sidecar-modules.md` → handoff.js) | `HANDOFF_POLL_MS`, `HANDOFF_TIMEOUT_MS`, `HANDOFF_MIN_CHARS`, `newHandoffId`, `handoffRel`, `threadDescFor`, `handoffRequestPrompt`, `handoffTakeoverPrompt`, `startHandoff`, `handoffPoll`, `endHandoff`, `cancelHandoff` |
| (after thread handoff) | **Thread consult** — ask another thread for a second opinion and bring the answer back: the asking thread writes the question to `.hivemind/consults/<id>.md`, the answering thread writes `<id>.reply.md`, and the reply is delivered into the asking thread's own conversation. Two poll-and-settle legs (`phase: 'question'` then `'answer'`) with state on the **asking** pane. `consultInboxTick` additionally adopts `ask-*.md` questions a thread wrote unprompted, on every hive with a live thread (see `docs/sidecar-modules.md` → consult.js) | `CONSULT_POLL_MS`, `CONSULT_QUESTION_TIMEOUT_MS`, `CONSULT_ANSWER_TIMEOUT_MS`, `CONSULT_MIN_CHARS`, `CONSULT_INBOX_MS`, `CONSULT_BOOT_MS`, `deliverConsultPrompt`, `newConsultId`, `consultRel`, `consultReplyRel`, `consultQuestionPrompt`, `consultAnswerPrompt`, `consultReturnPrompt`, `startConsult`, `beginConsult`, `adoptConsult`, `consultPrepare`, `consultPoll`, `endConsult`, `cancelConsult`, `consultField`, `consultAsker`, `consultInboxTick`, `consultAdoptRequest` |
| 1136–1310 | **Hivemind command** plumbing: wake word, fuzzy match, toast | `HM_WAKE_RE`, `HM_WAKE_MISHEARD`, `hmLooksLikeWake`, `matchHivemindCommand`, `hmToast`, `boardPanes`, `findPaneByName`, `HM_PASS`, `hmRouteTaskTo`, `hmExtractTask`, `hmResolveModel`, `HM_NEW_THREAD_RE`, `hmAgentWord`, `hmResolveThreadTarget` |
| 1311–1842 | **HM_COMMANDS registry** — ordered command list; `help` HTML per entry feeds the Help modal | `HM_COMMANDS` (entries: help, open-chat, new-thread, new-hive, consult, tell, handoff, close-thread, rename-thread, maximize, voice-*, interrupt, focus-thread, switch-hive, font-*, theme, model, agent, permission-mode, panel, show-plan, show-diff, show-terminal/chat, attach, history, settings, usage, build, task-in-thread, find, …) |
| 1844–1965 | Command dispatch + AI fallback | `renderHmCommandHelp` (generates `#hm-cmd-list`), `hmDispatch`, `hmNormalize`, `hmInterpretRequest` (`window.api.hm.interpret`), `runHivemindCommand` |
| 1967–2206 | **Chat with Hivemind** sidebar panel | `hmChatLog`, `hmChatOpen/Close/Toggle`, `setHmChatOpen`, `hmChatSubmit`, `hmChatDispatch`, `hmChatEditStart`, `hmChatVoiceCommit`, `hmChatVoiceSend`, `hmSpeak`, `wireHmChat`, Ctrl+Shift+H listener |
| 2208–2262 | Image drop/paste helpers, codex attachment staging | `isImageFile`, `persistImage`, `quotePath`, `pathInsideDir`, `stagePathForPane`, `typePathIntoPane` |
| 2264–2593 | **Chat wrapper** — the structured chat view over a thread | `CHAT_KINDS`, `globalChatFilters`, `transcriptSupported`, `historySupported`, `chatSupported`, `CHAT_PLACEHOLDER`, `initChatUI` (builds the whole chat DOM + wiring), `autosizeComposer` |
| 2595–2676 | Composer attachment chips | `fileUrlFor`, `addChatAttachment`, `removeChatAttachment`, `renderChatAttachments` |
| 2678–2885 | Composer autocomplete (`/` commands, `@` files) | `SLASH_COMMANDS`, `discoverProjectCommands`, `projectFileIndex`, `fuzzyMatchPath`, `renderAcText`, `initChatAutocomplete` |
| 2887–3007 | View toggle & chat chrome | `updateViewBtn`, `setPaneView`, `updateChatChrome`, `updateChatAvailability`, `applyChatFilters`, `resetChat`, `chatBindStatus` |
| 3009–3124 | Past-conversation history overlay (Claude only) | `relTimeShort`, `openHistoryPage`, `buildHistoryMenu`, `openHistorySession`, `exitHistory`, `updateHistoryChrome` |
| (with the history overlay) | **The conversation menu** — one `⋯` chip and one dropdown in the chat top bar holding hand off, second opinion and past conversations (engines: the Thread handoff / Thread consult sections, and the history overlay). Two levels: the root page lists the actions plus a *stop waiting* row per in-flight operation; picking one rebuilds the same element as that action's list with a `‹ Back` row. The chip is also the status light — `⇄ Handing off…` / `💬 Waiting on ‹thread›…` / `⋯ 2 waiting…`. It was three chips until the caption had nowhere left to render | `updateThreadMenuChip`, `toggleThreadMenu`, `hideThreadMenu`, `hideHistoryMenu`, `threadMenuRow`, `threadMenuHead`, `buildThreadMenu`, `buildThreadPicker`, `openHistoryPage` |
| 3126–3635 | **Chat rendering** from transcript entries | `chatIngest`, `renderChatEntries`, `renderChatEntry`, `chatKeyFor`, `upsertChatRow`, `wireCopyButton`, `addBubbleCopyBtn`, `addCodeCopyBtns`, `addUserOrMetaRow`, `CHAT_INTRO_MAX`, `noteChatIntro`, `setChatIntroOpen`, `syncChatIntro`, `jumpToChatIntro`, `setChatTopic`, `addMetaRow`, `addErrorRow`, `addSidechainRow`, `toolSummary`, `addToolRow`, `addQuestionRow`, `attachToolResult` |
| 3637–3800 | Composer send path | `chatHistoryNav` (↑/↓ recall), `sendChatMessage`, `continueHistorySession`, `ECHO_STALL_MS`, `flagStalledEcho`, `addEchoRow`, `confirmEcho` |
| 3802–3935 | Attention prompt card + composer lock | `PROMPT_CARD_KEY`, `PROMPT_LOCK_PLACEHOLDER`, `AUTH_LOCK_PLACEHOLDER`, `promptCardText`, `renderPromptCard`, `removePromptCard`, `updateComposerLock`, `updateChatBanner` |
| 3937–3996 | `$` helper; sidebar-resizer drag; **sidebar collapse**; top-level DOM refs | `$`, `SIDEBAR_W_*`, `SIDEBAR_COLLAPSE_KEY`, `sidebarCollapsed`, `setSidebarCollapsed`, `toggleSidebar`, `boardListEl`, `gridEl`, `emptyState`, `boardTitle`, `addTermBtn`, `buildBtn` |
| 3998–4082 | **Layout persistence** | `persist`, `serializeLayout`, `persistLayout`, `rebuildFromLayout` |
| 4084–4221 | Board list render + reorder; board switching | `renderBoardList`, `reorderBoards`, `selectBoard` |
| 4223–4395 | **Grid layout** (columns/panes/gutters, tmux-style zoom) | `MAX_COLS`, `layout`, `toggleZoom`, `paneLabel`, `buildZoomTabs`, `refreshZoomTabs`, `makeGutter`, `startDrag` |
| 4397–4521 | Pane creation entry points | `PANE_NAMES`, `pickPaneName`, `addTerminal`, `spawnPanePty` |
| 4523–4888 | **`createPane`** — builds the pane header (dot, title, plan chip, cost, status, agent/model/perm selects, view/font/zoom/close buttons), find bar, xterm Terminal + FitAddon + SearchAddon, drag/paste of images, `term.attachCustomKeyEventHandler` (Ctrl+V/F/±/0) | `createPane` |
| 4890–4978 | Rename, find bar, close, focus | `beginRename`, `openFind`, `closeFind`, `closePane`, `focusedPane`, `focusPane` |
| 4980–5022 | Fit + PTY events | `fitBoard`, `window resize` listener, `onPtyData`, `onPtyExit` handlers |
| 5024–5169 | Cost estimate + transcript event handlers | `costIngest`, `costUsd`, `resetPaneCost`, `renderPaneCost`, `transcript.onEntries` handler, `transcript.onStatus` handler, `findPane` |
| 5171–5311 | Board CRUD modal + empty state + top buttons | `openModal`, `closeModal`, `deleteBoard`, `showEmpty`, `onFocusPane` handler |
| 5313–5389 | **Keyboard pane navigation** + fs-change refresh | `orderedPanes`, `focusPaneByIndex`, `cycleFocus`, capture keydown (Ctrl+Enter / Ctrl+Shift+[] / Ctrl+1..9), `onFsChanged` handler |
| 5391–6514 | **Source Control panel** + Build Portable | `gitToggle/gitPanel/gitBody`, `activeBoard`, `activeDir`, `updateBuildButton`, `startPortableBuild`, `buildStageLabel`, `setGitOpen`, `gitRun`, `refreshGit`, `autoFetchGit`, `renderGitState`, `renderBranchBar`, `doRevertToRemote`, `renderCommitBox`, `doPull`, `doPush`, `doGenerateCommitMsg`, `renderSection`, `renderFileRow` |
| 6516–6679 | File Explorer panel | `filesToggle`, `setFilesOpen`, `refreshFiles`, `renderFxItem`, `openFile`, `insertPathIntoPane` |
| 6681–6753 | As-you-type autocorrect (all spellchecked fields) | `autocorrectEnabled`, `acEligibleField`, `acWordAt`, `acApply`, document `input`/`keydown` listeners |
| 7497–7709 | **Prompt History panel** (`.hivemind/prompt-history.json`) | `historyToggle`, `setHistoryOpen`, `refreshHistory`, `renderHistory`, `repostPrompt`, `revealPrompt`, `jumpToChatRow`, `recordPromptHistory` |
| 7710–8011 | **Plan review — detection** (transcript + screen) | `PLAN_FILE_RE`, `PLAN_MENU_*_RE`, `PLAN_APPROVED_RE`, `panePlan`, `planSetState`, `updatePlanChip`, `planScanEntries`, `planApplyResult`, `parsePlanMenu`, `planCardText`, `planScreenCheck`, `planBecameReady` |
| 8012–8245 | Plan review window | `planOpen`, `openPlanReview`, `closePlanReview`, `requestPlanFromThread`, `refreshPlanReview`, `startPlanPoll`/`planPollTick`, `renderPlanDocState`, `renderPlan`, `paintPlanActions` |
| 8247–8426 | **Markdown renderer** (dependency-free, GFM subset) + checkbox write-back | `mdInline`, `parseMdList`, `markdownToHtml`, `highlightOccurrence`, `plan-link` click handler, `plan-check` change handler |
| 8428–8711 | Plan comments + Approve / Request changes | `planCommentsKey`, `renderCommentList`, `saveDraftComment`, `resolveComment`, `persistComments`, `planAnswerMenu`, `planAwaitScreen`, `planSendFeedback` |
| 8713–8975 | Chat-card embedded plan review | `cardPlanComments`, `cardPersistComments`, `refreshCardPlan`, `buildCardPlanReview` |
| 8976–9090 | Diff viewer, branch menu, **global Escape handler** | `showDiff`, `escapeHtml`, `renderDiff`, `openBranchMenu`, `switchBranch` |
| 9091–9609 | Connect-to-GitHub wizard; **Clone-from-GitHub wizard** (New-hive modal); tiny DOM helpers | `openGitHubWizard`, `renderWizardChoice`, `startCreateFlow`, `doCreateRepo`, `renderLinkStep`, `doLink`, `renderDone`, `wizardActions`, `openCloneWizard`, `cloneStepCheck`, `renderCloneSignin`, `startCloneAuth`, `renderCloneChoose`, `cloneDoClone`, `el`, `mkBtn`, `mkMini` |
| (after the wizards) | **First-run setup wizard** — agent detection, install/sign-in step, first hive | `setupBackdrop`/`setupBody`/`setupMsg`, `SETUP_DONE_KEY`, `SETUP_RECHECK_MS`, `setupState`, `setupIsOpen`, `setupRecord`, `setupRefreshDetect`, `startSetupRecheck`/`stopSetupRecheck`, `openSetupWizard`, `closeSetupWizard`, `setupAgentStatus`, `setupAgentCard`, `renderSetupPick`, `setupCheckRow`, `setupInstallBlock`, `renderSetupConnect`, `renderSetupHive`, `finishSetup`, `maybeOpenSetupWizard` |
| 9611–10535 | **Voice typing** — dictionary, correction learning, STT worker, VAD, capture, hotkey | `VOICE_DEFAULT_DICT`, `voiceDict`, `applyVoiceDict`, `STT_MODELS`, `sttModelId`, `VOICE_ENTER_RE`, `voiceLearnRecord/Harvest/FromTexts`, `vlTokens`, `vlAlign`, `voiceSuggestShow`, `currentVoicePane`, `commitVoiceText`, `resetSttWorker`, `ensureSttWorker`, `bootSttWorker`, `flushSegment`, `onAudioFrame`, `onVadVerdict`, `applyVadDecision`, `startCapture`, `stopCapture`, `startVoice`, `stopVoice`, `toggleVoice`, `voiceErrMessage`, HUD fns, `~` hotkey listener |
| 10537–10838 | **Settings modal** (tabbed General/Voice) + ChatGPT accounts | `settingsBackdrop`, `setSettingsTab`, `renderVoiceDict`, `upsertVoiceDict`, `addVoiceDictEntry`, `syncVoiceFields`, `syncGeneralFields`, `openSettings`, `closeSettings` |
| 10840–11226 | Voice dictionary **training** modal | `voiceTrainState`, `vtExtractTerms`, `VT_TEMPLATES`, `vtGenerateSentences`, `vtPickPrompts`, `vtBuildSession`, `voiceTrainCommit`, `voiceTrainCheck`, `voiceTrainAdvance`, `vtSessionFromText`, `openVoiceTraining`, `closeVoiceTraining` |
| 11228–11469 | Per-agent **usage** pill + modal (Claude + ChatGPT) | `fmtTokens`, `fmtReset`, `fmtAge`, `usageSeverity`, `agentLimits`, `agentTop`, `accountTitle`, `renderUsagePill`, `renderUsageAccount`, `renderUsageTokens`, `renderUsageAgent`, `renderUsageModal`, `refreshUsage` (60 s interval; `force` only from ⟳), `openUsage`, `closeUsage` |
| 11471–11604 | Help modal open/close; Settings-tab control wiring | `openHelp`, `closeHelp`, `set-theme`/`set-default-model`/`set-default-font`/`set-notify`/`set-plan-autopopup`/`set-autocorrect` handlers, voice checkbox/model handlers |
| 11606–11623 | **Init** — load accounts + boards in parallel, select first or show empty (clears the boot state) | `init` IIFE, `hideBootState` |

## Core data model

### boards / grids

- `boards` (`renderer.js:8`) — array of `{ id, name, dir, startupCommand, resumeOnStart, muted, layout }`. Loaded via `window.api.listBoards()` in `init`, saved whole via `persist()` → `window.api.saveBoards`.
- `grids` — `Map<boardId, grid>` where a grid is `{ el, columns: [{ el, flex, panes: [pane] }], zoomed?: pane }`. Built lazily the first time a board is selected (`selectBoard`, `renderer.js:~4175`). Switching boards only toggles `display` — PTYs and terminals keep running in the background.
- Tiling (`addTerminal`): new threads add a column until `MAX_COLS` (3, `renderer.js:~5281`), then
  wrap — the next pane stacks into the shortest existing column. Saved layouts are replayed
  verbatim by `rebuildFromLayout`, so a hive tiled wider before the cap keeps its columns.
- Layout persistence: `serializeLayout` captures columns/flex plus per-pane metadata (name, agent, model, codexModel, perm, fontSize, flex, caption, autoName, planId/planFile/planSource, sessionId, view, chatFilters). PTYs are never serialized. `rebuildFromLayout` recreates panes on startup and respawns each PTY (resume-on-start uses `--resume <sessionId>`).

### pane

Created in `createPane` (`renderer.js:~4523`). The important fields:

| Field | Meaning |
|---|---|
| `id` | PTY id (`term-<ts>-<n>`); **changes on every respawn** (`respawnPane`) so stale PTY events can't reach the pane |
| `el`, `term`, `fitAddon`, `searchAddon` | pane DOM root, xterm `Terminal`, fit + search addons |
| `dot`, `statusEl`, `costEl`, `planChip`, `title`, `caption`, `viewBtn`, `findBar`, `findInput` | header/find DOM refs |
| `agentSelect`, `modelSelect`, `codexModelSelect`, `grokModelSelect`, `codexAccountSelect`, `permSelect` | header dropdowns |
| `board`, `col`, `flex`, `disposed` | back-refs, split size, tombstone flag |
| `name`, `autoName`, `captionText`, `capBuf` | thread nickname ("Leo"), legacy auto-name flag, caption + keystroke buffer |
| `state` | `null` \| `'busy'` \| `'idle'` \| `'attention'` \| `'error'` \| `'dead'` (see `setPaneState`) |
| `buf`, `idleTimer`, `probeTimer`, `menuMiss`, `errored`, `errorText`, `hintShown`, `doneGlow` | status-detection state |
| `needsAuth`, `authText` | the CLI is sitting on a sign-in prompt (`setNeedsAuth`): drives the header's `sign in` label, the 🔑 chat card, and the composer-lock wording |
| `agent`, `model`, `codexModel`, `grokModel`, `codexAccount`, `permMode`, `fontSize` | per-thread config. `codexAccount` is an account id resolved to a `CODEX_HOME` by main (see `docs/main-process.md`); a saved layout may name one that has since been removed, and the dropdown says so rather than silently switching |
| `permRunning`, `permPending` | permission mode the live process was spawned in, and a mode switch queued behind a running turn (see "Permission modes" below) |
| `sessionId`, `sessionBound` | Claude session UUID (passed as `--session-id`); `sessionBound` only true once the transcript proves the file exists — **never `--resume` an unbound id** |
| `costSeen`, `costByModel`, `costFile` | cost-estimate accumulator (Claude only) |
| `planId`, `plan` | plan-review lifecycle (`panePlan` lazily fills `plan`: state/file/source/menu/exitIds/cardText/cardComments/…) |
| `handoff` | in-flight handoff of this thread's conversation (`{ id, rel, dest, started, lastMtime, busy, timer }`) or `null`. **Not persisted** — an unfinished brief has no waiting thread after a restart; `disposePaneResources` clears the poll timer |
| `consult` | in-flight second opinion this thread asked for (`{ id, dest, phase: 'question'\|'answer', topic, destOpened, started, lastMtime, busy, timer }`) or `null`. Lives on the **asking** pane only. **Not persisted**, same reasoning as `handoff`; `disposePaneResources` clears the poll timer |
| `spawnName` | the name this pane's *process* was spawned under, put in its environment as `HIVEMIND_THREAD`. A rename never reaches the running process, so `consultAsker` matches this before the current name |
| `view`, `chatFilters`, `chat` | `'chat'`\|`'term'`, filter chips, and the chat object built by `initChatUI` |
| `termFallback` | terminal shown only because the transcript was missing — snaps back to chat on bind |

`pane.chat` (built in `initChatUI`, `renderer.js:~2309`) holds the chat DOM (`wrap, list, input, sendBtn, notice, chips, attachRow, topic, working, menuBtn/threadMenu — with `historyMenu` aliased to that same element, since the history list is one page of it — historyBar`), render maps (`byKey` row-key→element, `toolByUseId`, `pendingResults`, `pendingQuestions`, `pendingEcho` — each entry carries an `ECHO_STALL_MS` timer that marks the bubble "⚠ no response yet" if the transcript never echoes it back and the pane isn't busy, cleared by `confirmEcho`), history-view state (`viewingHistory`, `historySession`), composer state (`attachments`, `history`, `histIdx`, `histDraft`, `ac`), intro-bar state
(`intro`, `introText`, `introChevron`, `introRow`, `introOpen`), and `pinned` (auto-scroll).

### Conversation intro bar

A conversation that outgrows the pane scrolls its opening message away, so
`.chat-intro` — a one-line bar between the history bar and the message list —
pins the prompt the conversation started from above the messages. `noteChatIntro`
takes the text from the **first** user row rendered (`addUserOrMetaRow`, after its
meta/plumbing filter, so a `<command-name>` line never wins) and remembers the row
as `introRow`; nothing later replaces it, and `resetChat` clears it so a respawn,
session rollover, or a session opened from 🕘 History names itself from its own
first message.

`syncChatIntro` decides visibility geometrically — the bar shows only while
`introRow`'s rect sits above the list's top edge — and runs on list scroll and
after every `renderChatEntries` batch (a backfill buries the opening message
without firing a scroll event). It no-ops when the list has zero height, so a
pane on a hidden hive or in terminal view keeps the state it had when last
visible instead of resolving every rect to 0 and showing the bar. Clicking the
bar toggles `introOpen` (full prompt, capped at `CHAT_INTRO_MAX` chars and
`30vh`); `jumpToChatIntro` (the ↑ button) reuses `jumpToChatRow` so the jump
flashes the message like a Prompt History jump does.

### xterm wiring

**In-chat CLI interaction:** `setChatInteraction` moves the existing `.pane-term`
host into `.chat-interaction`, below the message list. The **Interact** toolbar,
question-card, sign-in, missing-transcript, and stalled-message buttons open it;
**Done** returns the host to `.pane-body` and focuses the composer. There is one
xterm and one PTY throughout. View changes and history browsing close the panel;
the existing resize observer also watches its size. Clicking inside it must keep
focus on xterm so arrows, Tab, paste, and custom answers reach the CLI.

`chatComposerBlocked` distinguishes live menus, pending tool questions, sign-in,
and explicit y/n or press-Enter prompts from ordinary prose questions. It gates
the composer, `sendChatMessage`, `typePrompt`'s delayed Enter, and `confirmSubmit`.
An `attention` status alone must not prevent a normal follow-up from submitting.
Generic prompt-card quick keys also require the screen to match their rendered
snapshot at click time.

Claude 2.1.261 can flush an unanswered AskUserQuestion into the transcript.
While a screen card is live, transcript question rows are temporarily hidden
with `.screen-question-covered`, then restored when the menu disappears so the
answered record remains visible. The screen card includes CLI-added custom-answer
options; choosing **Type something** or **Chat about this** opens Interact.

- Terminal options set in `createPane`: `fontFamily` Cascadia Code, `scrollback: 5000`, `theme: THEME` (a mutable object `applyTheme` rewrites), and on Windows `windowsPty: { backend: 'conpty' }` — required so full-screen TUI reflow matches ConPTY.
- IO: `term.onData` → `sendToPane` → `window.api.writePty`; `window.api.onPtyData` → `pane.term.write` + `markActivity`; `onPtyExit` → state `'dead'`.
- Sizing: `pane.fitAddon.fit()` then `window.api.resizePty(pane.id, cols, rows)`. `fitBoard(boardId)` re-fits all panes in a `requestAnimationFrame`. **`spawnPanePty` fits synchronously before spawning** — a deferred fit can land after Claude boots into a wrong-sized PTY and leave phantom characters (see the comment at `renderer.js:~4459`).
- Key handling: xterm stores **exactly one** custom key handler — all shortcuts inside a terminal (Ctrl+V passthrough, Ctrl+F, Ctrl±/0) live in the single `term.attachCustomKeyEventHandler` in `createPane`. Calling it again elsewhere overwrites everything.
- Status detection reads the *visible screen* via `screenText(pane)` (translates the active buffer rows), not the raw stream.

### Pane state machine

`markActivity` (any PTY output) → `'busy'` + resets a 1 s idle timer + starts the 700 ms `probeAttention` interval. Quiet for `IDLE_MS` → `evaluateIdle`: scans screen+buffer for `AUTH_PATTERNS` (→ `'attention'` with `needsAuth`), then the buffer for `ERROR_PATTERNS` (→ `'error'`), then the screen for `MENU_PATTERNS`/`QUESTION_PATTERNS` (→ `'attention'`), else `'idle'`. `busy→idle` sets the green "✓ done" glow (`setDoneGlow`), cleared by `focusPane`. State transitions drive OS notifications (`notify`), the sidebar badges, the zoom-tab dots, and the chat banner/composer lock.

**Sign-in detection** (`AUTH_PATTERNS` → `setNeedsAuth`) is its own signal because a login screen carries neither menu chrome nor a prose question: without it the pane reads as an ordinary finished turn, so a chat-view user watches a sent message vanish with no explanation. It is checked *before* errors (an expired token usually also trips `authentication_error`) and by `probeAttention` as well as `evaluateIdle` (login screens repaint, so they never go quiet). `needsAuth` changes the header label to `sign in`, replaces the prompt card with a 🔑 "Sign in to continue" card that has no quick keys (there's nothing useful to press), and swaps the composer-lock placeholder. It is cleared by respawn, by death, and by the next scan that no longer sees it — `evaluateIdle` drops `pane.buf` when it matches there so a stale `/login` line can't re-flag a recovered thread.

### Permission modes

Claude Code takes the permission mode as a **startup flag** (`--permission-mode`
/ `--dangerously-skip-permissions`) with no live slash-command equivalent, so
`setPanePerm` applies a change to a running thread by restarting it
(`restartForPerm` → `respawnPane` with `resume: (sessionBound && sessionId) ||
!!captionText`).

Restarting **mid-turn is destructive**: the in-flight turn never lands in the
session file, so the resumed thread comes back at an empty composer and reads as
"Claude stopped thinking and just sat there". So a switch made while
`pane.state === 'busy'` is *queued* in `pane.permPending` instead:

- `pane.permMode` (and the dropdown) update immediately — that's the mode the
  next spawn uses, so any other respawn satisfies the queue (`respawnPane` clears
  `permPending`).
- `pane.permRunning` records the mode the live process was actually spawned in,
  so flipping back to it cancels the queued restart.
- `applyPendingPerm` is scheduled (on a `setTimeout(…, 0)`, since the restart
  re-enters the state machine) from **both** `evaluateIdle` — going quiet is when
  a queue can land, and it fires even when the pane re-settles into the state it
  was already in — and `setPaneState`, which covers `'dead'`. It restarts on
  `'idle'`/`'error'`, drops the queue on `'dead'`, and **waits through
  `'attention'`**: restarting under a blocking menu would discard the question
  the thread is asking, so the switch lands after the user answers.
  ⚠ Don't rely on `setPaneState` alone — it early-returns on an unchanged state.
- While queued, `paintPermSelect` adds `.perm-pending` (dashed + dimmed) and
  retitles the dropdown; the dropdown `onchange` and the `permission-mode`
  HM command also toast "applies when this thread finishes its turn".

`.perm-bypass` (amber) marks the risky mode regardless of pending state.

## UI structure

`src/index.html` is a static skeleton; renderer.js fills and wires it. Main regions:

- `#app` → `#sidebar` + `#sidebar-resizer` + `#workspace`. `#sidebar.collapsed` (and, via `+`, the resizer) is `display:none` — the whole sidebar hides; `setSidebarCollapsed`/`toggleSidebar` own that class, persist `hm.sidebarCollapsed`, swap the `«` (`#sidebar-collapse`, sidebar header) and `»` (`#sidebar-expand`, first child of `#board-bar`) buttons, and re-fit the panes. Ctrl+Shift+B toggles it; the `sidebar` HM command does too. **The way back is never inside the hidden thing**: `#sidebar-expand` lives in the board bar, and `syncSidebarPanelState` restores the sidebar whenever a docked panel opens while collapsed — otherwise Ctrl+Shift+H and the Explorer/Git/History commands would silently do nothing.
- **Sidebar**: `.sidebar-header` (logo, `#add-board` ＋), `#board-list` (hive `<li class="board-item">` rows with status dot, badge, ✎/🗑 actions, drag-reorder), four docked panels that take over the board list's space when open — `#files-panel`, `#git-panel` (`#git-body`, `#git-msgbar`), `#hm-chat` (`#hm-chat-log`, `#hm-chat-input`, `#hm-chat-send`), `#history-panel` — then `.sidebar-actions` (toggle buttons `#files-toggle`, `#git-toggle`, `#history-toggle`, `#hm-chat-toggle`). Panels are mutually exclusive: each `setXOpen(true)` closes the siblings, and the sidebar gets a `files-open`/`git-open`/`publish-open`/`history-open`/`hm-open` class. `syncSidebarPanelState()` derives one more class from those, `panel-open`, which collapses `#board-list` to just `.board-item.active` — the hive you are working on stays pinned above whichever panel is showing. Clicking that pinned row toggles `hives-peek` on the sidebar (full list, capped at 45% height) so hives stay switchable without closing the panel; any panel open/close and any hive switch clears it.
- **Workspace**: `#board-bar` (`#board-title`, `#board-meta`, `#usage-btn` pill (holds one `.usage-seg` span per agent, filled by `renderUsagePill`), `#voice-toggle` (inline SVG mic), `#settings-btn` ⚙, `#help-btn` ❔, `#add-term` "＋ Thread"), `#grid` (holds one `.board-grid` per opened hive; inside, `.column` > `.pane` separated by `.gutter-col`/`.gutter-row`), plus overlays `#voice-hud`, `#hm-toast`, `#voice-suggest`, `#boot-state` (see Boot state) and `#empty-state` (`.empty-actions` holds `#empty-setup` → the setup wizard and `#empty-add-board` → the New-hive modal).
- **Pane** (all built in `createPane`, no HTML template): `.pane` > `.pane-header` (`.dot`, `.title-wrap`, `.pane-plan-chip`, `.cost`, `.status`, agent/model/codex/perm `<select class="model-select">`, `.view-btn` (pill: `.view-icon` + `.view-label`, showing the view it switches *to*), `.zoom-btn` ⛶, ✕) + `.find-bar` + `.pane-body` (`.pane-term` xterm host + `.chat-wrap` overlay from `initChatUI`). The chat view **covers** the terminal (absolute positioning); the terminal is never `display:none` so fit stays correct. `.pane` state classes: `focused`, `zoomed`, `done`, `drag-over`, `term-view`, `term-chat`.
- **Modals** (all `<div id="X-backdrop" class="hidden"><div id="X-modal">…` and closed by clicking the backdrop): `#modal-backdrop` (hive create/edit: `#modal-name/dir/cmd/resume/muted`), `#diff-backdrop`, `#plan-backdrop` (plan review: `#plan-doc-body`, `#plan-doc-comments`, approve/request buttons), `#branch-backdrop`, `#gh-backdrop` (GitHub wizard), `#settings-backdrop` (tabs `.settings-tab[data-tab]` / panels `.settings-panel[data-panel]`; ids `set-theme`, `set-default-model`, `set-default-codex-model`, `set-default-font`, `set-notify`, `set-plan-autopopup`, `set-autocorrect`, `#build-group`/`#build-portable`, voice ids `voice-model`, `voice-hotkey-enabled`, `voice-auto-enter`, `voice-auto-space`, `voice-reply-enabled`, `voice-dict-*`), `#voice-train-backdrop`, `#help-backdrop` (**`#help-modal`** — see Invariants), `#usage-backdrop`, `#setup-backdrop` (first-run setup wizard: `#setup-title`, `#setup-steps`, `#setup-body`, `#setup-msg`).
- The Help modal's "Hivemind commands" list `#hm-cmd-list` is **generated at startup** from `HM_COMMANDS[].help` by `renderHmCommandHelp` — never hand-edit that `<ul>`.
- CSP in `index.html` head allows `hm:` (offline STT assets), `blob:` workers, and `wasm-unsafe-eval` — needed by the voice worker; don't tighten it casually.

## Shared skill autocomplete

The composer discovers canonical project skills in `.agents/skills/`
and inserts plain instructions to read their SKILL.md files. Claude panes also
offer Claude built-ins and legacy project commands/skills. Shared skills win
over duplicate legacy wrappers. Discovery uses the guarded files IPC and a
five-second cache keyed by project directory and agent. See
[agent-instructions.md](agent-instructions.md) for the complete behavior and
tests; the implementation is `discoverProjectCommands` and
`initChatAutocomplete`.

## @-mention file picker

`@` completes against **every** file in the hive, not just the folder the token
names: typing filters the whole project the way an editor's quick-open does.

`projectFileIndex(dir)` fetches the flat path list once per project directory
over `files:index` (see `docs/git-and-files.md`) and caches it in
`fileIndexCache`; `fileItems` ranks it locally with `fuzzyMatchPath` on every
keystroke, because a project-wide fuzzy match per keypress cannot cross IPC.
The cache is dropped by `invalidateFileIndex` from the `fs:changed` handler — a
file a thread just wrote has to be mentionable immediately — and by a 60 s TTL
for whatever the watcher misses.

`fuzzyMatchPath` scores **both** greedy scan directions (`greedyHits`) and keeps
the better one. Each is wrong in the opposite way: forward-greedy anchors on
first occurrences, so `rend` against `src/renderer.js` lights up the `r` of
`src`; backward-greedy anchors on last ones, so the same query against
`docs/renderer.md` reaches past the name to the `d` of `.md`. `scoreHits`
rewards contiguous runs, word and camelCase starts, and characters landing in
the file name rather than a parent folder. The returned `hits` are indices into
the path, which `renderAcText` uses to bold and underline the matched characters
across the two columns (`hitBase` splits name from folder) — built from text
nodes, never `innerHTML`, since these are file names an agent thread wrote.

Two things rank above raw score: paths mentioned earlier in the session
(`fileMentionRecent`, recorded by `noteFileMention` on accept), and — with
nothing typed yet — shallow paths, so bare `@` opens on the top of the hive.

The index is `.gitignore`-filtered, so it deliberately omits `node_modules/`,
`dist/`, and friends. Once something *is* typed, `fileItems` also merges a plain
`files:list` of the folder named by the last `/`, ranked below the indexed
matches: pointing a thread at a build artifact or a `.env` is exactly when you
need the path the index doesn't carry. That listing is skipped for an empty
query, or the bare `@` menu would open on `node_modules/`.

## Boot state

`#boot-state` (`.empty.boot`, a spinner + *"Loading your hives…"*) and the
`.board-skel` placeholder rows in `#board-list` are what the **first paint**
shows. They exist because `#grid` and `#empty-state` can't both be right before
`init` has read `boards.json`: the markup used to ship `#empty-state` visible,
so every start flashed the *Welcome — Set up an agent* screen at users who had
hives, reading as "this app is not set up yet" until the real workspace
appeared seconds later.

So the markup ships `#grid` **and** `#empty-state` hidden, `#board-title` reading
*"Loading…"*, and `#boot-state` visible. Both routes out — `selectBoard` and
`showEmpty` — call `hideBootState()`, which is the only thing that clears it;
`init` awaits `refreshCodexAccounts` and `listBoards` together (they don't need
each other, and both must land before a pane is built) with a `.catch` on each,
because a rejection there would strand the app on the spinner.

## First-run setup wizard

`#setup-backdrop`, built entirely by `renderSetup*`. It exists because Hivemind
runs agent CLIs and never talks to a model service itself: on a machine with no
agent installed the app cannot do anything, and used to say nothing about it —
the first thread just died on PowerShell's *"'claude' is not recognized as the
name of a cmdlet"*.

Three steps, over `setupState` (`{ step, agent, detect, dir, name, from, busy }`,
null while closed):

1. `renderSetupPick` — one `.setup-agent` card per `AGENTS` entry, each with a
   `.setup-chip` computed by `setupAgentStatus` from the `agents:detect` record.
   The chip is the point of the screen: *which of these can I use right now* is
   exactly what a new user can't answer alone.
2. `renderSetupConnect` — a two-item checklist (`setupCheckRow`): the CLI, and
   the sign-in. A missing CLI gets `setupInstallBlock` (the install command with
   a Copy button, or an `openExternal` link when `install` is a URL).
3. `renderSetupHive` — name + directory, then `finishSetup` pushes a board in
   the same shape the New-hive modal writes, persists, and calls `selectBoard`,
   whose automatic first `addTerminal` runs on the chosen agent.

Things that are load-bearing:

- **The pick is saved as `defaultAgent`** (`hm.agent`), in `renderSetupHive` —
  reaching step 3 is the commitment. Without it the wizard would end by opening
  a Claude thread for someone who just picked ChatGPT.
- **Step 2 polls** (`startSetupRecheck`, `SETUP_RECHECK_MS`) while the CLI is
  missing or unsigned, because the user is expected to go and fix that in
  *another window*; it re-renders only when the answer actually changed, and
  stops as soon as the step is green or the wizard leaves step 2. This is why
  `agents:detect` must stay filesystem-only (see `docs/main-process.md`).
- **Sign-in is not done here, deliberately.** Each CLI signs in through its own
  terminal flow, and the thread path already handles it well (`AUTH_PATTERNS` →
  `setNeedsAuth` → the "sign in" header + 🔑 chat card). A modal copy would only
  be a worse second implementation.
- **An unknown sign-in state is never reported as "not signed in"** — `signedIn`
  is `true`/`false`/`null` and null is worded as "the thread will ask you if it
  needs to", which is always true. A false alarm sends the user off to
  re-authenticate a working account.
- **Every close path writes `hm.setupDone`** (`closeSetupWizard`), finished or
  skipped. It is a welcome, not a gate; a second uninvited appearance would be
  worse than never showing it. `maybeOpenSetupWizard` (called from `init` after
  `showEmpty`) opens it only when there are no boards *and* that key is unset.
- It is **first in the global Escape chain** and has the highest modal z-index
  (80): it can be opened from Settings, and its last step is a hive form the
  New-hive modal (z-index 50) must not cover.

Reachable afterwards from `#empty-setup`, Settings → General → Agent setup
(`#open-setup`), and the `setup` entry in `HM_COMMANDS`.

## Keyboard shortcuts

Global (capture-phase document listeners, so they win over xterm):

| Keys | Action | Where |
|---|---|---|
| `~` (Backquote, no modifiers) | Toggle voice typing (dictates into focused thread / open Chat-with-Hivemind / training modal) | `renderer.js:~9262`; disabled by `hm.voiceHotkey='0'`; a literal backtick still types in non-thread text fields |
| `Ctrl+Shift+H` | Toggle Chat with Hivemind panel | `renderer.js:~2201` |
| `Ctrl+Shift+B` | Hide / show the sidebar | Pane navigation listener, before the `activeBoardId` guard (`toggleSidebar`) |
| `Ctrl+Enter` | Maximize / restore focused thread | `renderer.js:~5352` (`toggleZoom`) |
| `Ctrl+Shift+]` / `Ctrl+Shift+[` | Cycle focus next / previous thread | `renderer.js:~5356` (`cycleFocus`) |
| `Ctrl+1`…`Ctrl+9` | Focus Nth thread on the active hive | `renderer.js:~5361` |
| Ctrl+F | Find in terminal scrollback. From chat, opens Interact and the find bar while keeping the conversation visible. Escape closes the find bar; Done closes Interact. | Pane navigation listener |
| `Esc` | Close the top open dialog — priority order: voice training → clone-from-GitHub wizard → **New/Edit-hive dialog** → plan review → diff → branch → GitHub wizard → usage → help → settings | `renderer.js:~8143` |

Inside a terminal pane (`term.attachCustomKeyEventHandler` in `createPane`):

| Keys | Action |
|---|---|
| `Ctrl+F` | Open the pane's find bar (Enter = next, Shift+Enter = previous, Esc = close) |
| `Ctrl+V` | Passed to the browser so the paste listener can intercept images |
| `Ctrl+=`/`+`, `Ctrl+-`, `Ctrl+0` | Font size up / down / reset (also works in chat view via a capture listener on `.chat-wrap`) |
| `Ctrl+scroll` | Font size up/down (both terminal and chat views) |

Composer / field-local:

| Keys | Action |
|---|---|
| `Enter` / `Shift+Enter` in chat composer | Send / newline (`sendChatMessage`) |
| `↑` / `↓` in composer (caret on first/last line) | Recall sent-message history (`chatHistoryNav`); while autocomplete is open they navigate it, `Tab`/`Enter` accept, `Esc` dismisses |
| `@` in composer | Project-wide file picker — see **@-mention file picker** |
| `Enter` in `#hm-chat-input` | Send command; `Esc` inside the panel closes it |
| `Ctrl+Enter` in git commit box (`#git-msg`) | Push |
| `Ctrl/Cmd+Enter` in plan comment textarea | Save comment |
| `Enter` in voice-training modal | Check (listen phase) / Next (review phase) |
| Double-click pane title | Rename thread (`beginRename`; Enter commits, Esc cancels) |

Mouse extras: drag gutters resize splits; drag sidebar-resizer sets sidebar width (double-click resets); drag hive rows reorders them; drag files onto a pane/chat attaches them.

## Settings & localStorage

All persistence is `localStorage` (renderer-local) except boards/layouts (JSON via `window.api.saveBoards`) and per-project files (`.hivemind/prompt-history.json`, `.hivemind/plans/*`).

| Key | Meaning / values | Read at |
|---|---|---|
| `hm.theme` | Theme id (`midnight`, `forest`, `ember`, `grape`, `paper`, `rose`) | `renderer.js:161`, written by `applyTheme` |
| `hm.fontSize` | Default font size for new threads (8–32); updated on *every* per-pane change. Settings' `A−`/`A+` stepper (`applyDefaultFontSize`) also pushes the new size to every open pane — there is no per-thread font button any more, only `Ctrl+=`/`−`/`0` and `Ctrl+scroll` | `setPaneFontSize`, `applyDefaultFontSize`, Settings `set-default-font` |
| `hm.model` | Default Claude model (`default`/`fable`/`opus`/`sonnet`/`haiku`); updated on every per-pane pick | `setPaneModel`, Settings |
| `hm.codexModel` | Default ChatGPT/Codex model | `setPaneCodexModel`, Settings |
| `hm.grokModel` | Default Grok Build model | `setPaneGrokModel`, Settings |
| `hm.codexAccount` | Default ChatGPT account id for new threads. **The account list itself is not here** — it lives in userData (`codex.js`); this is only the default, reset to `default` when it names an account that's gone | `setPaneCodexAccount`, `refreshCodexAccounts`, Settings |
| `hm.agent` | Default agent for new threads (`claude`/`codex`/`gemini`/`grok`). Read only by `createPane`'s fallback and `addTerminal`'s auto-name — **restored panes never reach it** (`rebuildFromLayout` resolves a missing agent to `claude` first), so changing it can't rewrite saved threads | `defaultAgent` / `setDefaultAgent`, Settings `set-default-agent`, the setup wizard's step 3 |
| `hm.perm` | Default permission mode (`default`/`acceptEdits`/`auto`/`plan`/`bypass`) | `setPanePerm` |
| `hm.setupDone` | `'1'` once the first-run setup wizard has been closed — finished **or** skipped. The only thing that stops it reappearing, so it is written on every close path | `maybeOpenSetupWizard`, `closeSetupWizard` (`SETUP_DONE_KEY`) |
| `hm.muteNotifications` | `'1'` mutes OS notifications | `notifyMuted`, Settings `set-notify` (inverted) |
| `hm.chatFilters` | JSON `{tool,thinking,meta,subagent}` — default filter chips for new panes | `globalChatFilters`, chip clicks |
| `hm.sidebarWidth` | Sidebar width px (180–600) | sidebar-resizer IIFE |
| `hm.autocorrect` | `'0'` disables as-you-type autocorrect (default on) | `autocorrectEnabled` |
| `hm.planAutoOpen` | `'0'` disables the plan-review auto-popup (default on) | `planBecameReady`, Settings `set-plan-autopopup` |
| `hm.voiceDict` | JSON `[{from,to}]` dictionary applied to dictation | `loadVoiceDict` / `saveVoiceDict` |
| `hm.voiceHotkey` | `'0'` disables the `~` hotkey (default on) | `voiceHotkeyEnabled` |
| `hm.voiceAutoEnter` | `'1'` = saying "press enter"/"submit" sends Enter (default off) | `voiceAutoEnter` |
| `hm.voiceAutoSpace` | `'0'` disables trailing space after each phrase (default on) | `voiceAutoSpace` |
| `hm.voiceReply` | `'1'` = speak Hivemind chat replies aloud (default off) | `voiceReplyEnabled` |
| `hm.voiceModel` | STT model id (must be in `STT_MODELS`) | `sttModelId` |
| `hm.voiceLearn` | JSON map of learned correction candidates `{key:{from,to,n,dismissed}}` | `loadVoiceLearn` (`VOICE_LEARN_KEY`) |

Non-persisted per-pane choices (view, chatFilters, model, codexModel, grokModel, codexAccount, font…) ride in the board **layout** instead (`serializeLayout`).

Model selectors begin with safe fallbacks so startup never waits on a CLI. `refreshAgentModels` then asks main for the installed providers' current catalogs at startup, whenever Settings opens, and on manual refresh. Codex catalogs are kept per ChatGPT account; saved selections missing from a temporary catalog remain visible as `(saved)`. Claude and Grok switch live with `/model`; Codex restarts because Hivemind supplies its model at startup.

The **ChatGPT accounts** list in Settings → General is the one settings block backed by the main process rather than localStorage: `renderCodexAccountSettings` rebuilds it from the cached `codexAccounts`, and `refreshCodexAccounts` re-reads it on startup, whenever Settings opens, after every add/rename/remove/sign-out, and when a ChatGPT thread stops asking to sign in (`setNeedsAuth`, which is when a `codex login` has just landed). Account labels are user text, so rows are built with `textContent`, never `innerHTML`.

## Preload API usage

Everything the renderer calls on `window.api`, grouped (names only — schemas live in `preload.js`/`main.js`):

- **PTY**: `spawnPty`, `writePty`, `resizePty`, `killPty`, `onPtyData`, `onPtyExit`
- **Boards**: `listBoards`, `saveBoards`
- **Transcript binder** (`window.api.transcript.*`): `bind`, `unbind`, `noteSent`, `refresh`, `listSessions`, `readSession`, `onEntries`, `onStatus`
- **Git** (`window.api.git.*`): `status`, `fetch`, `pull`, `push`, `init`, `stage`, `unstage`, `stageAll`, `unstageAll`, `discard`, `commit`, `diff`, `branches`, `checkout`, `createBranch`, `setRemote`, `resetToRemote`, `ghCheck`, `ghCreateRepo`, `ghListRepos`, `ghClone`, `ghAuthStart`, `ghAuthCancel`, `onGhAuthStatus`, `aiCommitMessage`
- **Files** (`window.api.files.*`): `list`, `open`, `reveal`
- **Prompt history** (`window.api.promptHistory.*`): `read`, `write`, `append`, `ensureIgnored`
- **Plans** (`window.api.plan.*`): `read`, `readFile`, `write`, `readComments`, `writeComments`, `ensureIgnored`
- **Build** (`window.api.build.*` + event): `isHivemind`, `portable`, `onBuildProgress`
- **Hivemind AI command fallback**: `hm.interpret`
- **Usage**: `usage.get({ force })`
- **Voice / STT**: `stt.ensureModel`, `onSttDownloadProgress`
- **Misc**: `notify`, `onFocusPane`, `setWatch`, `onFsChanged`, `pickDir`, `pickFiles`, `saveTempImage`, `clipboardImage`, `stageAttachment`, `openExternal`, `spellCorrect` (synchronous), `platform`, `osBuild`, `appVersion`

## Styling conventions

- **Theme = CSS custom properties on `:root`**: `--bg`, `--bg-alt`, `--panel`, `--surface`, `--text`, `--muted`, `--accent`, `--accent-2`, `--border`, `--danger`, `--peach`, `--yellow`, `--on-accent`, `--gutter`. `styles.css:1` hard-codes the Midnight defaults so the app paints before JS runs; `applyTheme` overwrites them live and simultaneously repaints every xterm palette. Light themes (Paper, Rose) work purely through these variables — there is no `prefers-color-scheme` handling and no `dark`/`light` class; **never hard-code colours, always use the variables** (`--on-accent` exists precisely so light themes can flip text on accent fills).
- `styles.css` (~2,350 lines) is organized with banner comments (`/* ---------------- Section ---------------- */`) roughly mirroring renderer.js sections: Sidebar, Workspace, Grid, Chat wrapper, Empty state, Modal, File Explorer, Source Control, Prompt History, Plan review, Diff viewer, Branch menu, GitHub wizard, Voice typing, Chat with Hivemind, Settings modal, Usage modal, Help modal, "Added features".
- Naming: plain kebab-case classes with a feature prefix — `chat-*` (chat view), `plan-*`, `git-*` (also reused by the other sidebar panels for headers/msgbars: `.git-header`, `.git-msgbar`, `.git-empty`), `fx-*` (file explorer), `hm-*` (Hivemind chat/toast), `vt-*`/`voice-*`, `gh-*`, `vd-*` (voice dict). Ids for singletons, classes for repeated widgets.
- Visibility is done with a shared `.hidden` class (`display:none`), state with modifier classes (`active`, `sel`, `listening`, `answered`, `done`, `zoomed`, `perm-bypass`, `composer-locked`, `viewing-history`).
- Chat text scales off the per-pane `--pane-font` variable set on `.pane` by `setPaneFontSize`; the composer height feeds `--chat-composer-h` (used by `.pane.term-chat` to inset the terminal).
- Chat kind filtering is pure CSS: `.chat-wrap.hide-tool .chat-row[data-kind="tool"] { display:none }` etc. — flipping a chip never re-renders rows.
- Status colours (busy yellow / attention peach / error red / idle green / dead grey) are shared by pane dots, status labels, sidebar dots, and zoom-tab dots; the pulse animation is `@keyframes hm-pulse`.
- Modal z-order: settings sits under the voice-training modal (training z 60+) — relevant when stacking new modals.

## Invariants & gotchas

1. **AGENTS.md rule — keep `#help-modal` in sync.** Any user-facing feature, shortcut, button, or setting change must update the Help modal content in `index.html` in the same change; the change is not done until it does. Exception: the "Hivemind commands" `<ul id="hm-cmd-list">` is generated from `HM_COMMANDS[].help` — update the registry entry's `help` string, not the HTML.
2. **`HM_COMMANDS` is ordered** — first matching pattern wins. Specific commands must sit above generic ones (voice "stop listening" above the interrupt catch-all; `find` last). An entry can return `HM_PASS` to decline its match.
3. **One xterm key handler.** `term.attachCustomKeyEventHandler` overwrites; every in-terminal shortcut must be added to the single handler in `createPane`.
4. **Spawn-time fit must stay synchronous.** `spawnPanePty` calls `fitAddon.fit()` before `spawnPty`; deferring it (rAF) breaks in occluded windows and leaves phantom characters on Claude's input line. Similarly the chat view *covers* the terminal (never `display:none`) so fit/ConPTY sizing stay valid while hidden; `setPaneView` re-fits on reveal.
   The *chat list* is the opposite case — `.pane.term-view .chat-wrap` **is** `display:none`, so while the terminal is showing the list has no layout box and every `scrollTop = scrollHeight` silently no-ops (`scrollTop` also reads back 0). `setPaneView` re-pins the list to the bottom in a `requestAnimationFrame` when revealing chat; without it, peeking at the terminal and coming back dropped the user at message #1 of the thread.
   `fitBoard` only sends `resizePty` when `cols`/`rows` actually changed (`pane.sentCols/sentRows`) — ConPTY reflow is what strands phantom characters, and `fit()` runs on far more than real size changes. The `window` `resize` listener is debounced (120 ms trailing); dragging a window edge otherwise issued one fit + one IPC per pane per frame.
4a. **The submit-retry loop must be able to see a wrapped prompt, and must not strand short ones.** `typePrompt` withholds its Enter whenever a menu is up and hands the whole responsibility to `confirmSubmit`. Two rules keep that honest:
   - **`promptStuckOnScreen` reads the composer as a *block*, not a row.** A wrapped prompt puts its head on the block's **first** row, and in bordered builds every continuation row repeats the `│` prefix — so anchoring on the bottom-most prefixed row and slicing *downward* cut off the very text being looked for. It now finds the bottom-most composer row, extends **upward** across the contiguous block, and matches against the flattened block (`flattenRows`: strip box chrome, collapse whitespace) using a 24-char head. The old 40-char single-row `includes` could never match below ~45 columns — which is exactly what the app's own multi-column tiling produces on a normal window, so the retry silently never fired in the default layout.
   - **`confirmSubmit(..., { owesEnter: true })` is how a withheld Enter gets delivered.** The `head.length < 3` early-return skips the *verification* loop, which is fine for a normal send (`typePrompt` already pressed Enter) but stranded every short reply typed while a menu was up — "ok", "yes", "no", "1" were pasted and then never submitted by any path. With `owesEnter`, the call waits the menu out and presses Enter once it clears; pressing it only after the menu is gone is what keeps invariant 8b intact.

5. **`pane.id` changes on respawn** (`respawnPane`) so late data/exit events from the killed PTY can't reach the pane — always re-look-up panes via `findPane(id)` in event handlers, and call `window.api.transcript.unbind` before changing the id.
6. **Session-resume rules**: never `--resume` a session id whose file hasn't been proven to exist (`pane.sessionBound`, set only when transcript entries arrive) — resuming an unwritten session dies with "No conversation found" and strands the pane. `'bound'` status alone does **not** prove the file exists.
7. **Layout must be attached before spawning**: `createPane` returns a detached pane; callers must run `layout(boardId)` then `spawnPanePty` (see `addTerminal` / `rebuildFromLayout`).
8. **Status detection is heuristic and version-pinned.** `MENU_PATTERNS`, `SELECT_FOOTER_RE`, `AUTH_PATTERNS`, `PERM_SCREEN_RE`, the plan-menu regexes and the AskUserQuestion screen parsers were verified against specific Claude Code (v2.1.20x–2.1.22x) and codex-rs TUI output; when CLI wording drifts, these regexes are what to update. `AUTH_PATTERNS` in particular must stay anchored on strings the CLI really prints (they were lifted from the v2.1.221 binary) — a false positive there locks the composer on a healthy thread. Screen scans are wrap-tolerant (`joinWrapped`/`testWrapped` — the TUI hard-wraps at pane width) and shed `│┃` box chrome (`stripBoxChrome`); option scans anchor on the "1." row closest above the footer and abort on out-of-sequence numbers so prose/diff lists can't become clickable options. Buttons deliberately degrade to "answer in the terminal" rather than sending blind digits.
8a. **Two AskUserQuestion menu layouts, two answering rules** (verified v2.1.220). A plain menu answers on the digit alone. A menu whose options carry `preview` text renders side-by-side — option list left, the focused option's preview boxed on the right, a "Notes: press n to add notes" hint under it — and there a digit only *moves* the selection; **Enter commits it**. `parseScreenQuestion` therefore cuts every row at the preview box's left column (`previewCutColumn`, computed on the *raw* lines: `stripBoxChrome` eats that edge as if it were dialog chrome, which is what used to spill box art and preview code into option labels/descriptions) and returns `needsEnter`, which is the only case where a card click follows its digit with an Enter (re-checking `cardMenuLive` first). Never send that Enter for a menu that answers immediately — it would land in whatever screen came next. The unnumbered "Chat about this" row of that layout is menu chrome, like "Submit".
8b. **Every card button re-verifies the live screen at click time before writing to the PTY.** Question-card options and Review⇥ go through `cardMenuLive` (screen cards must still match the rendered menu's question+labels; transcript cards need `menuOnScreen`); prompt-card quick keys require `state === 'attention'` plus `promptVisibleOnScreen`; single-select cards lock after one send (`card.dataset.sent`, self-expires); options ≥ 10 are disabled (two-keystroke digits would actuate option 1); `typePrompt`'s delayed Enter and `confirmSubmit` wait a menu out instead of actuating it. A stale click must never inject keys into a menu or turn it wasn't aimed at — keep this property when touching any card handler.
8c. **Menu keystrokes must not become the thread caption.** `sendToPane(pane, data, { caption: false })` skips `feedCaptionInput`; every card/menu send (option digits, the preview-layout Enter, Review⇥, prompt-card quick keys, plan approve/feedback) passes it — **and so does each image path in `typePrompt`**, which is plumbing rather than something the user typed. `typePrompt` / `deliverPrompt` / `confirmSubmit` also take the flag for the *whole* prompt (`deliverPrompt(pane, text, [], { caption: false })`) — used by thread handoff and thread consult, whose request prompts are multi-line outlines that would otherwise caption the thread with its last line; the caller sets a readable caption itself. The flag has to reach the trailing Enter and every `confirmSubmit` retry, or that Enter commits whatever was left in `capBuf`. Left on, the attached paths landed in `capBuf` and the trailing Enter committed `C:\…\shot.png` + the prompt as the thread's caption, which was then persisted into the layout. Caption tracking rebuilds the *user's input line*, so a digit with no Enter behind it otherwise lingers in `capBuf` and glues itself to the front of the next real prompt, and pasted review feedback would replace the thread's task caption. Stranded transcript questions (a `tool_use` whose result never lands) age out via `syncQuestionExpiry` instead of pinning attention/composer-lock forever; pane death clears all pending-question state.
8d. **"Request changes" submits the feedback itself.** `planSendFeedback` presses the keep-planning option, waits for its inline input, pastes the comments, waits for that text to show up on screen, then sends Enter (with one bounded retry) — it must *not* route through `typePrompt`, which by design refuses to press Enter while a menu is on screen, so the feedback silently sat in the menu's input while the card/window claimed it had been sent. It returns `false` when the text is still visibly stuck in the menu, and both callers (`planReqChangesBtn`, the card's Request-changes button) say so instead of reporting success.
8e. **The permission dropdown is read back from the screen, never inferred.** Claude Code owns the live mode — shift+tab cycles manual → accept edits → plan → auto, and approving a plan drops the thread out of plan mode — so `permScreenCheck` (called from both probes, next to `planScreenCheck`) matches the footer hint (`PERM_SCREEN_MODES`, v2.1.220 wording) and updates `pane.permMode` + the select + the persisted layout **without respawning**; only `setPanePerm` restarts a thread. It acts only on a positive match (a dialog covering the footer must not read as a mode change) and ignores the screen for `PERM_SETTLE_MS` after a deliberate switch (stamped by `restartForPerm`), so the dying process's last frame can't revert the new mode. A screen-read mode is also what the live process is running, so it updates `pane.permRunning` and clears a `permPending` that just came true — otherwise a queued switch would restart a thread that shift+tab already moved to that very mode. `auto` is a real CLI mode (`--permission-mode auto`) and must stay in `PERMS`, or the dropdown can't represent a thread that approved a plan with "Yes, and use auto mode".
8f. **A permission switch never lands mid-turn.** `setPanePerm` queues the mode in `pane.permPending` (dashed/dimmed dropdown via `paintPermSelect`) for **any** state that isn't `idle`/`error`, instead of restarting; `applyPendingPerm` fires it from the quiet path once the pane settles. Restarting mid-turn discards the in-flight work — it never reaches the session file, so the resumed thread comes back at an empty composer and reads as "Claude stopped thinking and just sat there". Attention waits for the same reason: a restart under a blocking menu throws away the question being asked. **Both functions must agree on the condition** — `setPanePerm` used to queue only on `busy` and send `attention` straight to a restart, so the one case `applyPendingPerm`'s comment called out was the one the entry path didn't honour. `applyPendingPerm` is the single arbiter of *when*; `setPanePerm` only decides *whether*. Flipping back to `pane.permRunning` cancels the queue.

8g. **A dropdown must never type into a menu.** The model dropdowns apply live by typing `/model …\r` into the running thread, and a dropdown can be used at any moment — including while the thread sits on a permission prompt. Writing then puts the command in the menu's filter and the trailing `\r` actuates the highlighted row, i.e. approves something the user never read. `setPaneModel`/`setPaneGrokModel` therefore go through **`writeSlashWhenClear`**, which waits the menu out on `SLASH_RETRY_MS` (same cadence as `confirmSubmit`) and gives up rather than forcing it — a dropped model switch is recoverable, a mis-actuated approval is not. Both also check `changed` first, so re-picking the current model doesn't retype anything. This is invariant 8b applied to header controls: *every* write path re-verifies the live screen.
8h. **The composer lock uses `readOnly`, never `disabled`, and always says why.** A `disabled` input cannot receive focus, so `focusPane`'s `chat.input.focus()` silently no-oped and clicking a locked thread left the keyboard pointed at the *previously* focused pane — the next thing typed went to the wrong thread's PTY. `readOnly` still blocks typing while staying focusable and scrollable; sending is blocked by `sendBtn.disabled` plus the guard in `sendChatMessage`, which **toasts** rather than returning silently (dictating into a locked thread and saying "send" used to drop the whole message with no feedback).

8i. **`confirmEcho` matches, and declines to guess.** It tries the exact text, then the message's first line (an image send stores `text\n🖼 name` while the transcript records only `text`), and only falls back to "the oldest pending echo" when exactly one is outstanding. Blindly taking index 0 on any mismatch confirmed message A's bubble away using message B's line, cancelling A's `ECHO_STALL_MS` timer — so the "⚠ no response yet" warning that exists for precisely that case never fired. `resetChat` clears those timers along with the array.

9. **Never `innerHTML` user/agent text.** User strings always go through `textContent`; markdown goes through the in-house `markdownToHtml` whose `escapeHtml` escapes quotes for attribute safety. Keep it that way.
10. **Sidebar panels are mutually exclusive** — a new docked panel must close the others in its `setXOpen` and be closed by theirs, plus toggle a `sidebar` class, disable its toggle in `showEmpty`, and refresh in `selectBoard` via an `xOnBoardChange` hook. Note this is wired by hand in N² fashion (six `setXOpen` bodies cross-calling each other, plus a repeated block in `showEmpty`); it is the main reason `showEmpty` kept forgetting `hm-open`. Every one of those sites must end with `syncSidebarPanelState()` — the `panel-open`/pinned-hive class is derived, not set by hand, so a setter that skips it leaves the sidebar claiming the wrong project (or none). A registry would be the right shape if a seventh panel ever appears.

12. **One pane teardown list: `disposePaneResources`.** `closePane` and `deleteBoard` both call it, and nothing else may hand-roll teardown. It clears the idle/question/echo timers, disconnects `composerResizeObserver`, revokes attachment blob URLs, closes the plan review if the pane owns it, drops `focusedPane` if it points here, kills the pty, unbinds the transcript, and disposes the terminal. `deleteBoard` used to carry a shorter copy, so deleting a hive with N threads leaked N ResizeObservers and every staged blob URL and left the plan review polling a deleted hive's directory.

13. **`persist()` is debounced, not immediate.** Callers are hot — a caption update on every Enter in every thread, every screen-read permission change, every transcript status push, every dropdown and gutter drag — and each call re-serializes *every* board. `persist()` coalesces on a 400 ms trailing timer and chains writes so two `saveBoards` calls never overlap on the same file; it still returns a promise that resolves once the caller's data is on disk, so `await persist()` keeps its meaning. A `beforeunload` listener flushes a pending write. Don't reintroduce a direct `persistNow()` call from UI code.

14. **`selectBoard` resolves before it commits.** Assigning `activeBoardId` ahead of the `boards.find` lookup left the app pointing at a hive that doesn't exist whenever the id was stale (a `focus-pane` notification for a deleted hive, a bad command target), after which the grid, `＋ Thread`, `fitBoard` and every `xOnBoardChange` silently no-oped.
11. **`chatIngest` is suppressed while viewing history** (`c.viewingHistory`) — anything that must never miss a transcript entry (plan detection, cost) runs *before* it in the `transcript.onEntries` handler.
12. **`upsertChatRow` keys rows by transcript uuid** so re-emitted lines update in place; re-renders must preserve open `<details>` folds and clicked-option echoes (see `addQuestionRow`'s `prevSel` logic) — a naive re-render loses in-flight interaction state.
13. **Concurrent edits**: the user's own Hivemind threads edit this repo in parallel (see memory). Re-read files before editing; on-disk stores (`prompt-history.json`) are re-read before append precisely because another thread may have written them.
15. **Escape handling is centralized** for backdrop modals in one document listener (~`renderer.js:8143`) with an explicit priority chain; non-modal panels (hm-chat, find bar) handle Esc locally with `stopPropagation`. A new modal must be added to that chain — the Help modal promises "Esc — close the open dialog", so a modal missing from the chain makes that text false. The New/Edit-hive dialog was missing, and it is the first modal a new user ever sees.
15. Themes: `THEME` is **mutated in place** by `applyTheme` so new terminals pick up the current palette from the shared object — replace its contents, don't reassign it.

## How to extend

**Add a toolbar button** (board bar): add the `<button id="my-btn">` in `index.html` next to `#settings-btn`, style it (`.icon-btn` or `.pill-btn` in styles.css), then wire it near the other toolbar wiring (`renderer.js:~10040`): `const b = $('my-btn'); if (b) b.onclick = …`. If it should be disabled with no hive open, disable it in `showEmpty` and enable it in `selectBoard`. For a per-thread header button, instead create it inside `createPane`, append it into `header.append(...)`, add `mousedown` `stopPropagation` (so clicking doesn't steal focus) and remember narrow panes hide low-priority header controls via CSS. **Update the Help modal.**

**Add a keyboard shortcut**: for a global shortcut, add a capture-phase `document.addEventListener('keydown', …, true)` near the pane-navigation block (`renderer.js:~5339`), guard against typing in editable fields the way that block does (`xterm-helper-textarea` and `chat-input` count as pane, not field), and call `e.preventDefault(); e.stopImmediatePropagation()`. For a shortcut that must work inside terminals, add it to the single `attachCustomKeyEventHandler` in `createPane` instead. **Add it to the Shortcuts list in `#help-modal`.**

**Add a settings field**: (1) add the control to the right `.settings-panel` in `index.html`; (2) add a `let mySetting = localStorage.getItem('hm.mySetting') …` near the related feature; (3) populate it in `syncGeneralFields`/`syncVoiceFields`; (4) wire its `change` handler near `renderer.js:~10055` to update the variable and `localStorage.setItem`. Use the `hm.` key prefix. Per-thread settings instead go through `createPane` opts + `serializeLayout`/`rebuildFromLayout` so they persist in the layout. **Document it in Help.**

**Add a new modal**: copy the pattern — in `index.html`: `<div id="x-backdrop" class="hidden"><div id="x-modal">…</div></div>` with a `.settings-head` header and ✕ button; in styles.css reuse the settings-modal look (see the Usage/Help modals); in renderer.js: `openX()`/`closeX()` toggling `hidden`, a backdrop `mousedown` self-target close, and an entry in the global Escape chain at `renderer.js:~8143` (mind the priority order). If Hivemind commands should open it, add an `HM_COMMANDS` entry (with a `help` string, which auto-documents it).

**Add a Hivemind command**: append an entry `{ name, patterns: [regex…], help: '<strong>…</strong>', run(m, { board, pane }) { … } }` to `HM_COMMANDS` at the right position (specific before generic; before `task-in-thread`/`find`). `help: null` hides it from the Help list (use when a sibling documents it). Toast results with `hmToast(msg[, 'err'])` — it auto-mirrors into the Chat-with-Hivemind panel.

**Add a docked sidebar panel**: copy the Prompt History panel — `<aside id="x-panel">` in `index.html` with a `.git-header`, a toggle button in `.sidebar-actions`; in renderer.js a `setXOpen(open)` that closes all sibling panels (and is called by each of theirs), toggles `sidebar.classList` (add the matching `.x-open` CSS) **and calls `syncSidebarPanelState()`** (add the new `x-open` to the list it scans, or the active hive stops being pinned above your panel), `xOnBoardChange()` called from `selectBoard`, and disable/hide handling in `showEmpty`.
