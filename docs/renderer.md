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
and its helper modules (`git.js`, `files.js`, `transcript.js`, `plan.js`, `todo.js`,
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
| 215–251 | Claude model list + API list prices (cost chip) | `MODELS`, `defaultModel`, `MODEL_PRICES`, `priceForModel` |
| 253–295 | Codex (ChatGPT) models; permission modes | `CODEX_MODELS`, `defaultCodexModel`, `PERMS`, `defaultPerm` |
| 297–436 | **Agents** (claude/codex/gemini) + per-pane setters | `AGENTS`, `agentFor`, `paneCommand`, `setPaneAgent`, `respawnPane`, `setPaneModel`, `setPaneCodexModel`, `paintPermSelect`, `setPanePerm` |
| 438–545 | **Terminal status detection** constants | `IDLE_MS`, `STATE_LABEL`, `SELECT_FOOTER_RE`, `REVIEW_PROMPT_RE`, `MENU_PATTERNS`, `QUESTION_PATTERNS`, `ERROR_PATTERNS`, `CMD_MISSING_PATTERNS`, `stripAnsi`, `screenText`, `joinWrapped`, `menuOnScreen`, `promptVisibleOnScreen`, `PROBE_MS`, `chatHasPendingQuestion`, `syncQuestionExpiry` |
| 547–843 | Screen-parsed question cards + attention probe | `stripBoxChrome`, `testWrapped`, `parseScreenQuestion`, `parseScreenReview`, `parsePlanScreenQuestion`, `parseCodexApproval`, `syncScreenQuestion`, `cardMenuLive`, `removeScreenQuestion`, `probeAttention`, `startAttentionProbe`, `stopAttentionProbe` |
| 845–978 | **Pane state machine** (busy/idle/attention/error/dead) | `markActivity`, `evaluateIdle`, `setDoneGlow`, `setPaneState`, `notify` |
| 980–1020 | Sidebar per-board status dots/badges | `boardStatus`, `updateBoardStatus` |
| 1022–1103 | Thread captions (rebuilt from keystrokes) | `feedCaptionInput`, `REPLY_WORDS`, `isReplyLike`, `commitCaption`, `setPaneCaption`, `sendToPane` |
| 1105–1170 | Prompt delivery to a PTY — bracketed paste, size-scaled Enter delay, screen-verified Enter retry when the submit gets swallowed as part of the paste burst | `typePrompt`, `SUBMIT_RETRY_MS`, `confirmSubmit`, `deliverPrompt` |
| 1136–1310 | **Hivemind command** plumbing: wake word, fuzzy match, toast | `HM_WAKE_RE`, `HM_WAKE_MISHEARD`, `hmLooksLikeWake`, `matchHivemindCommand`, `hmToast`, `boardPanes`, `findPaneByName`, `HM_PASS`, `hmRouteTaskTo`, `hmExtractTask`, `hmResolveModel` |
| 1311–1842 | **HM_COMMANDS registry** — ordered command list; `help` HTML per entry feeds the Help modal | `HM_COMMANDS` (entries: help, open-chat, add-todo, new-thread, new-hive, tell, close-thread, rename-thread, maximize, voice-*, interrupt, focus-thread, switch-hive, font-*, theme, model, agent, permission-mode, panel, show-plan, show-diff, show-terminal/chat, attach, history, settings, usage, build, task-in-thread, find, …) |
| 1844–1965 | Command dispatch + AI fallback | `renderHmCommandHelp` (generates `#hm-cmd-list`), `hmDispatch`, `hmNormalize`, `hmInterpretRequest` (`window.api.hm.interpret`), `runHivemindCommand` |
| 1967–2206 | **Chat with Hivemind** sidebar panel | `hmChatLog`, `hmChatOpen/Close/Toggle`, `setHmChatOpen`, `hmChatSubmit`, `hmChatDispatch`, `hmChatEditStart`, `hmChatVoiceCommit`, `hmChatVoiceSend`, `hmSpeak`, `wireHmChat`, Ctrl+Shift+H listener |
| 2208–2262 | Image drop/paste helpers, codex attachment staging | `isImageFile`, `persistImage`, `quotePath`, `pathInsideDir`, `stagePathForPane`, `typePathIntoPane` |
| 2264–2593 | **Chat wrapper** — the structured chat view over a thread | `CHAT_KINDS`, `globalChatFilters`, `transcriptSupported`, `historySupported`, `chatSupported`, `CHAT_PLACEHOLDER`, `initChatUI` (builds the whole chat DOM + wiring), `autosizeComposer` |
| 2595–2676 | Composer attachment chips | `fileUrlFor`, `addChatAttachment`, `removeChatAttachment`, `renderChatAttachments` |
| 2678–2885 | Composer autocomplete (`/` commands, `@` files) | `SLASH_COMMANDS`, `initChatAutocomplete` |
| 2887–3007 | View toggle & chat chrome | `updateViewBtn`, `setPaneView`, `updateChatChrome`, `updateChatAvailability`, `applyChatFilters`, `resetChat`, `chatBindStatus` |
| 3009–3124 | Past-conversation history overlay (Claude only) | `relTimeShort`, `toggleHistoryMenu`, `buildHistoryMenu`, `openHistorySession`, `exitHistory`, `updateHistoryChrome` |
| 3126–3635 | **Chat rendering** from transcript entries | `chatIngest`, `renderChatEntries`, `renderChatEntry`, `chatKeyFor`, `upsertChatRow`, `wireCopyButton`, `addBubbleCopyBtn`, `addCodeCopyBtns`, `addUserOrMetaRow`, `setChatTopic`, `addMetaRow`, `addErrorRow`, `addSidechainRow`, `toolSummary`, `addToolRow`, `addQuestionRow`, `attachToolResult` |
| 3637–3800 | Composer send path | `chatHistoryNav` (↑/↓ recall), `sendChatMessage`, `continueHistorySession`, `addEchoRow`, `confirmEcho` |
| 3802–3935 | Attention prompt card + composer lock | `PROMPT_CARD_KEY`, `promptCardText`, `renderPromptCard`, `removePromptCard`, `updateComposerLock`, `updateChatBanner` |
| 3937–3996 | `$` helper; sidebar-resizer drag; top-level DOM refs | `$`, `SIDEBAR_W_*`, `boardListEl`, `gridEl`, `emptyState`, `boardTitle`, `addTermBtn`, `buildBtn` |
| 3998–4082 | **Layout persistence** | `persist`, `serializeLayout`, `persistLayout`, `rebuildFromLayout` |
| 4084–4221 | Board list render + reorder; board switching | `renderBoardList`, `reorderBoards`, `selectBoard` |
| 4223–4395 | **Grid layout** (columns/panes/gutters, tmux-style zoom) | `layout`, `toggleZoom`, `paneLabel`, `buildZoomTabs`, `refreshZoomTabs`, `makeGutter`, `startDrag` |
| 4397–4521 | Pane creation entry points | `PANE_NAMES`, `pickPaneName`, `addTerminal`, `spawnPanePty` |
| 4523–4888 | **`createPane`** — builds the pane header (dot, title, plan chip, cost, status, agent/model/perm selects, view/font/zoom/close buttons), find bar, xterm Terminal + FitAddon + SearchAddon, drag/paste of images, `term.attachCustomKeyEventHandler` (Ctrl+V/F/±/0) | `createPane` |
| 4890–4978 | Rename, find bar, close, focus | `beginRename`, `openFind`, `closeFind`, `closePane`, `focusedPane`, `focusPane` |
| 4980–5022 | Fit + PTY events | `fitBoard`, `window resize` listener, `onPtyData`, `onPtyExit` handlers |
| 5024–5169 | Cost estimate + transcript event handlers | `costIngest`, `costUsd`, `resetPaneCost`, `renderPaneCost`, `transcript.onEntries` handler, `transcript.onStatus` handler, `findPane` |
| 5171–5311 | Board CRUD modal + empty state + top buttons | `openModal`, `closeModal`, `deleteBoard`, `showEmpty`, `onFocusPane` handler |
| 5313–5389 | **Keyboard pane navigation** + fs-change refresh | `orderedPanes`, `focusPaneByIndex`, `cycleFocus`, capture keydown (Ctrl+Enter / Ctrl+Shift+[] / Ctrl+1..9), `onFsChanged` handler |
| 5391–5992 | **Source Control panel** + Build Portable | `gitToggle/gitPanel/gitBody`, `activeBoard`, `activeDir`, `updateBuildButton`, `startPortableBuild`, `buildStageLabel`, `setGitOpen`, `gitRun`, `refreshGit`, `autoFetchGit`, `renderGitState`, `renderBranchBar`, `doRevertToRemote`, `renderCommitBox`, `doPull`, `doPush`, `doGenerateCommitMsg`, `renderSection`, `renderFileRow` |
| 5993–6149 | File Explorer panel | `filesToggle`, `setFilesOpen`, `refreshFiles`, `renderFxItem`, `openFile`, `insertPathIntoPane` |
| 6151–6225 | As-you-type autocorrect (all spellchecked fields) | `autocorrectEnabled`, `acEligibleField`, `acWordAt`, `acApply`, document `input`/`keydown` listeners |
| 6227–6626 | **Todo panel** (`.hivemind/todos.json`, nested items) | `todoToggle`, `setTodoOpen`, `refreshTodo`, `saveTodo`, `addTodo`, `matchTodoPrefix` (`TODO_PREFIX_RE`), `addTodoItem`, `captureTodo`, `addSubTodo`, `normalizeTodos`, `pushTodoToThread`, `startEditTodo`, `renderTodo`, `buildTodoList` |
| 6627–6839 | **Prompt History panel** (`.hivemind/prompt-history.json`) | `historyToggle`, `setHistoryOpen`, `refreshHistory`, `renderHistory`, `repostPrompt`, `revealPrompt`, `jumpToChatRow`, `recordPromptHistory` |
| 6840–7139 | **Plan review — detection** (transcript + screen) | `PLAN_FILE_RE`, `PLAN_MENU_*_RE`, `PLAN_APPROVED_RE`, `panePlan`, `planSetState`, `updatePlanChip`, `planScanEntries`, `planApplyResult`, `parsePlanMenu`, `planCardText`, `planScreenCheck`, `planBecameReady` |
| 7140–7360 | Plan review window | `planOpen`, `openPlanReview`, `closePlanReview`, `requestPlanFromThread`, `refreshPlanReview`, `startPlanPoll`/`planPollTick`, `renderPlanDocState`, `renderPlan`, `paintPlanActions` |
| 7362–7544 | **Markdown renderer** (dependency-free, GFM subset) + checkbox write-back | `mdInline`, `parseMdList`, `markdownToHtml`, `highlightOccurrence`, `plan-link` click handler, `plan-check` change handler |
| 7546–7793 | Plan comments + Approve / Request changes | `planCommentsKey`, `renderCommentList`, `saveDraftComment`, `resolveComment`, `persistComments`, `planAnswerMenu`, `planAwaitScreen`, `planSendFeedback` |
| 7794–8058 | Chat-card embedded plan review | `cardPlanComments`, `cardPersistComments`, `refreshCardPlan`, `buildCardPlanReview` |
| 8060–8152 | Diff viewer, branch menu, **global Escape handler** | `showDiff`, `escapeHtml`, `renderDiff`, `openBranchMenu`, `switchBranch`, Escape keydown at ~8143 |
| 8154–8417 | Connect-to-GitHub wizard; tiny DOM helpers | `openGitHubWizard`, `renderWizardChoice`, `startCreateFlow`, `doCreateRepo`, `renderLinkStep`, `doLink`, `renderDone`, `wizardActions`, `el`, `mkBtn`, `mkMini` |
| 8419–9278 | **Voice typing** — dictionary, correction learning, STT worker, VAD, capture, hotkey | `VOICE_DEFAULT_DICT`, `voiceDict`, `applyVoiceDict`, `STT_MODELS`, `sttModelId`, `VOICE_ENTER_RE`, `voiceLearnRecord/Harvest/FromTexts`, `vlTokens`, `vlAlign`, `voiceSuggestShow`, `currentVoicePane`, `commitVoiceText`, `resetSttWorker`, `ensureSttWorker`, `bootSttWorker`, `flushSegment`, `onAudioFrame`, `onVadVerdict`, `applyVadDecision`, `startCapture`, `stopCapture`, `startVoice`, `stopVoice`, `toggleVoice`, `voiceErrMessage`, HUD fns, `~` hotkey listener (~9262) |
| 9280–9434 | **Settings modal** (tabbed General/Voice) | `settingsBackdrop`, `setSettingsTab`, `renderVoiceDict`, `upsertVoiceDict`, `addVoiceDictEntry`, `syncVoiceFields`, `syncGeneralFields`, `openSettings`, `closeSettings` |
| 9436–9877 | Voice dictionary **training** modal | `voiceTrainState`, `vtExtractTerms`, `VT_TEMPLATES`, `vtGenerateSentences`, `vtPickPrompts`, `vtBuildSession`, `voiceTrainCommit`, `voiceTrainCheck`, `voiceTrainAdvance`, `vtSessionFromText`, `openVoiceTraining`, `closeVoiceTraining` |
| 9879–10038 | Claude **usage** pill + modal | `fmtTokens`, `fmtReset`, `usageSeverity`, `renderUsagePill`, `renderUsageModal`, `refreshUsage` (60 s interval), `openUsage`, `closeUsage` |
| 10040–10132 | Help modal open/close; Settings-tab control wiring | `openHelp`, `closeHelp`, `set-theme`/`set-default-model`/`set-default-font`/`set-notify`/`set-plan-autopopup`/`set-autocorrect` handlers, voice checkbox/model handlers |
| 10134–10143 | **Init** — load boards, select first or show empty | `init` IIFE |

## Core data model

### boards / grids

- `boards` (`renderer.js:8`) — array of `{ id, name, dir, startupCommand, resumeOnStart, muted, layout }`. Loaded via `window.api.listBoards()` in `init`, saved whole via `persist()` → `window.api.saveBoards`.
- `grids` — `Map<boardId, grid>` where a grid is `{ el, columns: [{ el, flex, panes: [pane] }], zoomed?: pane }`. Built lazily the first time a board is selected (`selectBoard`, `renderer.js:~4175`). Switching boards only toggles `display` — PTYs and terminals keep running in the background.
- Layout persistence: `serializeLayout` captures columns/flex plus per-pane metadata (name, agent, model, codexModel, perm, fontSize, flex, caption, autoName, planId/planFile/planSource, sessionId, view, chatFilters). PTYs are never serialized. `rebuildFromLayout` recreates panes on startup and respawns each PTY (resume-on-start uses `--resume <sessionId>`).

### pane

Created in `createPane` (`renderer.js:~4523`). The important fields:

| Field | Meaning |
|---|---|
| `id` | PTY id (`term-<ts>-<n>`); **changes on every respawn** (`respawnPane`) so stale PTY events can't reach the pane |
| `el`, `term`, `fitAddon`, `searchAddon` | pane DOM root, xterm `Terminal`, fit + search addons |
| `dot`, `statusEl`, `costEl`, `planChip`, `title`, `caption`, `viewBtn`, `findBar`, `findInput` | header/find DOM refs |
| `agentSelect`, `modelSelect`, `codexModelSelect`, `permSelect` | header dropdowns |
| `board`, `col`, `flex`, `disposed` | back-refs, split size, tombstone flag |
| `name`, `autoName`, `captionText`, `capBuf` | thread nickname ("Leo"), legacy auto-name flag, caption + keystroke buffer |
| `state` | `null` \| `'busy'` \| `'idle'` \| `'attention'` \| `'error'` \| `'dead'` (see `setPaneState`) |
| `buf`, `idleTimer`, `probeTimer`, `menuMiss`, `errored`, `errorText`, `hintShown`, `doneGlow` | status-detection state |
| `agent`, `model`, `codexModel`, `permMode`, `fontSize` | per-thread config |
| `sessionId`, `sessionBound` | Claude session UUID (passed as `--session-id`); `sessionBound` only true once the transcript proves the file exists — **never `--resume` an unbound id** |
| `costSeen`, `costByModel`, `costFile` | cost-estimate accumulator (Claude only) |
| `planId`, `plan` | plan-review lifecycle (`panePlan` lazily fills `plan`: state/file/source/menu/exitIds/cardText/cardComments/…) |
| `view`, `chatFilters`, `chat` | `'chat'`\|`'term'`, filter chips, and the chat object built by `initChatUI` |
| `termFallback` | terminal shown only because the transcript was missing — snaps back to chat on bind |

`pane.chat` (built in `initChatUI`, `renderer.js:~2309`) holds the chat DOM (`wrap, list, input, sendBtn, notice, chips, attachRow, topic, working, historyBtn/Menu/Bar`), render maps (`byKey` row-key→element, `toolByUseId`, `pendingResults`, `pendingQuestions`, `pendingEcho`), history-view state (`viewingHistory`, `historySession`), composer state (`attachments`, `history`, `histIdx`, `histDraft`, `ac`), and `pinned` (auto-scroll).

### xterm wiring

- Terminal options set in `createPane`: `fontFamily` Cascadia Code, `scrollback: 5000`, `theme: THEME` (a mutable object `applyTheme` rewrites), and on Windows `windowsPty: { backend: 'conpty' }` — required so full-screen TUI reflow matches ConPTY.
- IO: `term.onData` → `sendToPane` → `window.api.writePty`; `window.api.onPtyData` → `pane.term.write` + `markActivity`; `onPtyExit` → state `'dead'`.
- Sizing: `pane.fitAddon.fit()` then `window.api.resizePty(pane.id, cols, rows)`. `fitBoard(boardId)` re-fits all panes in a `requestAnimationFrame`. **`spawnPanePty` fits synchronously before spawning** — a deferred fit can land after Claude boots into a wrong-sized PTY and leave phantom characters (see the comment at `renderer.js:~4459`).
- Key handling: xterm stores **exactly one** custom key handler — all shortcuts inside a terminal (Ctrl+V passthrough, Ctrl+F, Ctrl±/0) live in the single `term.attachCustomKeyEventHandler` in `createPane`. Calling it again elsewhere overwrites everything.
- Status detection reads the *visible screen* via `screenText(pane)` (translates the active buffer rows), not the raw stream.

### Pane state machine

`markActivity` (any PTY output) → `'busy'` + resets a 1 s idle timer + starts the 700 ms `probeAttention` interval. Quiet for `IDLE_MS` → `evaluateIdle`: scans the buffer for `ERROR_PATTERNS` (→ `'error'`), then the screen for `MENU_PATTERNS`/`QUESTION_PATTERNS` (→ `'attention'`), else `'idle'`. `busy→idle` sets the green "✓ done" glow (`setDoneGlow`), cleared by `focusPane`. State transitions drive OS notifications (`notify`), the sidebar badges, the zoom-tab dots, and the chat banner/composer lock.

## UI structure

`src/index.html` is a static skeleton; renderer.js fills and wires it. Main regions:

- `#app` → `#sidebar` + `#sidebar-resizer` + `#workspace`.
- **Sidebar**: `.sidebar-header` (logo, `#add-board` ＋), `#board-list` (hive `<li class="board-item">` rows with status dot, badge, ✎/🗑 actions, drag-reorder), five docked panels that replace the board list when open — `#files-panel`, `#git-panel` (`#git-body`, `#git-msgbar`), `#todo-panel` (`#todo-input`, `#todo-body`, `#todo-footer`), `#hm-chat` (`#hm-chat-log`, `#hm-chat-input`, `#hm-chat-send`), `#history-panel` — then `.sidebar-actions` (toggle buttons `#files-toggle`, `#git-toggle`, `#todo-toggle`, `#history-toggle`, `#hm-chat-toggle`). Panels are mutually exclusive: each `setXOpen(true)` closes the siblings, and the sidebar gets a `files-open`/`git-open`/`todo-open`/`history-open`/`hm-open` class.
- **Workspace**: `#board-bar` (`#board-title`, `#board-meta`, `#usage-btn` pill, `#voice-toggle` 🎤, `#settings-btn` ⚙, `#help-btn` ❔, `#add-term` "＋ Thread"), `#grid` (holds one `.board-grid` per opened hive; inside, `.column` > `.pane` separated by `.gutter-col`/`.gutter-row`), plus overlays `#voice-hud`, `#hm-toast`, `#voice-suggest`, `#empty-state`.
- **Pane** (all built in `createPane`, no HTML template): `.pane` > `.pane-header` (`.dot`, `.title-wrap`, `.pane-plan-chip`, `.cost`, `.status`, agent/model/codex/perm `<select class="model-select">`, `.view-btn`, `.font-btn` A−/A+, `.zoom-btn` ⛶, ✕) + `.find-bar` + `.pane-body` (`.pane-term` xterm host + `.chat-wrap` overlay from `initChatUI`). The chat view **covers** the terminal (absolute positioning); the terminal is never `display:none` so fit stays correct. `.pane` state classes: `focused`, `zoomed`, `done`, `drag-over`, `term-view`, `term-chat`.
- **Modals** (all `<div id="X-backdrop" class="hidden"><div id="X-modal">…` and closed by clicking the backdrop): `#modal-backdrop` (hive create/edit: `#modal-name/dir/cmd/resume/muted`), `#diff-backdrop`, `#plan-backdrop` (plan review: `#plan-doc-body`, `#plan-doc-comments`, approve/request buttons), `#branch-backdrop`, `#gh-backdrop` (GitHub wizard), `#settings-backdrop` (tabs `.settings-tab[data-tab]` / panels `.settings-panel[data-panel]`; ids `set-theme`, `set-default-model`, `set-default-codex-model`, `set-default-font`, `set-notify`, `set-plan-autopopup`, `set-autocorrect`, `#build-group`/`#build-portable`, voice ids `voice-model`, `voice-hotkey-enabled`, `voice-auto-enter`, `voice-auto-space`, `voice-reply-enabled`, `voice-dict-*`), `#voice-train-backdrop`, `#help-backdrop` (**`#help-modal`** — see Invariants), `#usage-backdrop`.
- The Help modal's "Hivemind commands" list `#hm-cmd-list` is **generated at startup** from `HM_COMMANDS[].help` by `renderHmCommandHelp` — never hand-edit that `<ul>`.
- CSP in `index.html` head allows `hm:` (offline STT assets), `blob:` workers, and `wasm-unsafe-eval` — needed by the voice worker; don't tighten it casually.

## Keyboard shortcuts

Global (capture-phase document listeners, so they win over xterm):

| Keys | Action | Where |
|---|---|---|
| `~` (Backquote, no modifiers) | Toggle voice typing (dictates into focused thread / open Chat-with-Hivemind / training modal) | `renderer.js:~9262`; disabled by `hm.voiceHotkey='0'`; a literal backtick still types in non-thread text fields |
| `Ctrl+Shift+H` | Toggle Chat with Hivemind panel | `renderer.js:~2201` |
| `Ctrl+Enter` | Maximize / restore focused thread | `renderer.js:~5352` (`toggleZoom`) |
| `Ctrl+Shift+]` / `Ctrl+Shift+[` | Cycle focus next / previous thread | `renderer.js:~5356` (`cycleFocus`) |
| `Ctrl+1`…`Ctrl+9` | Focus Nth thread on the active hive | `renderer.js:~5361` |
| `Esc` | Close the top open dialog — priority order: voice training → plan review → diff → branch → GitHub wizard → usage → help → settings | `renderer.js:~8143` |

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
| `Enter` in `#hm-chat-input` | Send command; `Esc` inside the panel closes it |
| `Ctrl+Enter` in git commit box (`#git-msg`) | Push |
| `Ctrl/Cmd+Enter` in plan comment textarea | Save comment |
| `Enter` in voice-training modal | Check (listen phase) / Next (review phase) |
| Double-click pane title | Rename thread (`beginRename`; Enter commits, Esc cancels) |

Mouse extras: drag gutters resize splits; drag sidebar-resizer sets sidebar width (double-click resets); drag hive rows reorders them; drag files onto a pane/chat attaches them.

## Settings & localStorage

All persistence is `localStorage` (renderer-local) except boards/layouts (JSON via `window.api.saveBoards`) and per-project files (`.hivemind/todos.json`, `.hivemind/prompt-history.json`, `.hivemind/plans/*`).

| Key | Meaning / values | Read at |
|---|---|---|
| `hm.theme` | Theme id (`midnight`, `forest`, `ember`, `grape`, `paper`, `rose`) | `renderer.js:161`, written by `applyTheme` |
| `hm.fontSize` | Default font size for new threads (8–32); updated on *every* per-pane change | `setPaneFontSize`, Settings `set-default-font` |
| `hm.model` | Default Claude model (`default`/`fable`/`opus`/`sonnet`/`haiku`); updated on every per-pane pick | `setPaneModel`, Settings |
| `hm.codexModel` | Default ChatGPT/Codex model | `setPaneCodexModel`, Settings |
| `hm.perm` | Default permission mode (`default`/`acceptEdits`/`plan`/`bypass`) | `setPanePerm` |
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

Non-persisted per-pane choices (view, chatFilters, model, font…) ride in the board **layout** instead (`serializeLayout`).

## Preload API usage

Everything the renderer calls on `window.api`, grouped (names only — schemas live in `preload.js`/`main.js`):

- **PTY**: `spawnPty`, `writePty`, `resizePty`, `killPty`, `onPtyData`, `onPtyExit`
- **Boards**: `listBoards`, `saveBoards`
- **Transcript binder** (`window.api.transcript.*`): `bind`, `unbind`, `noteSent`, `refresh`, `listSessions`, `readSession`, `onEntries`, `onStatus`
- **Git** (`window.api.git.*`): `status`, `fetch`, `pull`, `push`, `init`, `stage`, `unstage`, `stageAll`, `unstageAll`, `discard`, `commit`, `diff`, `branches`, `checkout`, `createBranch`, `setRemote`, `resetToRemote`, `ghCheck`, `ghCreateRepo`, `aiCommitMessage`
- **Files** (`window.api.files.*`): `list`, `open`, `reveal`
- **Todo** (`window.api.todo.*`): `read`, `write`, `ensureIgnored`
- **Prompt history** (`window.api.promptHistory.*`): `read`, `write`, `append`, `ensureIgnored`
- **Plans** (`window.api.plan.*`): `read`, `readFile`, `write`, `readComments`, `writeComments`, `ensureIgnored`
- **Build** (`window.api.build.*` + event): `isHivemind`, `portable`, `onBuildProgress`
- **Hivemind AI command fallback**: `hm.interpret`
- **Usage**: `usage.get`
- **Voice / STT**: `stt.ensureModel`, `onSttDownloadProgress`
- **Misc**: `notify`, `onFocusPane`, `setWatch`, `onFsChanged`, `pickDir`, `pickFiles`, `saveTempImage`, `clipboardImage`, `stageAttachment`, `openExternal`, `spellCorrect` (synchronous), `platform`, `osBuild`, `appVersion`

## Styling conventions

- **Theme = CSS custom properties on `:root`**: `--bg`, `--bg-alt`, `--panel`, `--surface`, `--text`, `--muted`, `--accent`, `--accent-2`, `--border`, `--danger`, `--peach`, `--yellow`, `--on-accent`, `--gutter`. `styles.css:1` hard-codes the Midnight defaults so the app paints before JS runs; `applyTheme` overwrites them live and simultaneously repaints every xterm palette. Light themes (Paper, Rose) work purely through these variables — there is no `prefers-color-scheme` handling and no `dark`/`light` class; **never hard-code colours, always use the variables** (`--on-accent` exists precisely so light themes can flip text on accent fills).
- `styles.css` (~2,350 lines) is organized with banner comments (`/* ---------------- Section ---------------- */`) roughly mirroring renderer.js sections: Sidebar, Workspace, Grid, Chat wrapper, Empty state, Modal, File Explorer, Source Control, Todo, Prompt History, Plan review, Diff viewer, Branch menu, GitHub wizard, Voice typing, Chat with Hivemind, Settings modal, Usage modal, Help modal, "Added features".
- Naming: plain kebab-case classes with a feature prefix — `chat-*` (chat view), `plan-*`, `git-*` (also reused by the other sidebar panels for headers/msgbars: `.git-header`, `.git-msgbar`, `.git-empty`), `todo-*`, `fx-*` (file explorer), `hm-*` (Hivemind chat/toast), `vt-*`/`voice-*`, `gh-*`, `vd-*` (voice dict). Ids for singletons, classes for repeated widgets.
- Visibility is done with a shared `.hidden` class (`display:none`), state with modifier classes (`active`, `sel`, `listening`, `answered`, `done`, `zoomed`, `perm-bypass`, `composer-locked`, `viewing-history`).
- Chat text scales off the per-pane `--pane-font` variable set on `.pane` by `setPaneFontSize`; the composer height feeds `--chat-composer-h` (used by `.pane.term-chat` to inset the terminal).
- Chat kind filtering is pure CSS: `.chat-wrap.hide-tool .chat-row[data-kind="tool"] { display:none }` etc. — flipping a chip never re-renders rows.
- Status colours (busy yellow / attention peach / error red / idle green / dead grey) are shared by pane dots, status labels, sidebar dots, and zoom-tab dots; the pulse animation is `@keyframes hm-pulse`.
- Modal z-order: settings sits under the voice-training modal (training z 60+) — relevant when stacking new modals.

## Invariants & gotchas

1. **CLAUDE.md rule — keep `#help-modal` in sync.** Any user-facing feature, shortcut, button, or setting change must update the Help modal content in `index.html` in the same change; the change is not done until it does. Exception: the "Hivemind commands" `<ul id="hm-cmd-list">` is generated from `HM_COMMANDS[].help` — update the registry entry's `help` string, not the HTML.
2. **`HM_COMMANDS` is ordered** — first matching pattern wins. Specific commands must sit above generic ones (voice "stop listening" above the interrupt catch-all; `find` last). An entry can return `HM_PASS` to decline its match.
3. **One xterm key handler.** `term.attachCustomKeyEventHandler` overwrites; every in-terminal shortcut must be added to the single handler in `createPane`.
4. **Spawn-time fit must stay synchronous.** `spawnPanePty` calls `fitAddon.fit()` before `spawnPty`; deferring it (rAF) breaks in occluded windows and leaves phantom characters on Claude's input line. Similarly the chat view *covers* the terminal (never `display:none`) so fit/ConPTY sizing stay valid while hidden; `setPaneView` re-fits on reveal.
5. **`pane.id` changes on respawn** (`respawnPane`) so late data/exit events from the killed PTY can't reach the pane — always re-look-up panes via `findPane(id)` in event handlers, and call `window.api.transcript.unbind` before changing the id.
6. **Session-resume rules**: never `--resume` a session id whose file hasn't been proven to exist (`pane.sessionBound`, set only when transcript entries arrive) — resuming an unwritten session dies with "No conversation found" and strands the pane. `'bound'` status alone does **not** prove the file exists.
7. **Layout must be attached before spawning**: `createPane` returns a detached pane; callers must run `layout(boardId)` then `spawnPanePty` (see `addTerminal` / `rebuildFromLayout`).
8. **Status detection is heuristic and version-pinned.** `MENU_PATTERNS`, `SELECT_FOOTER_RE`, the plan-menu regexes and the AskUserQuestion screen parsers were verified against specific Claude Code (v2.1.20x/2.1.21x) and codex-rs TUI output; when CLI wording drifts, these regexes are what to update. Screen scans are wrap-tolerant (`joinWrapped`/`testWrapped` — the TUI hard-wraps at pane width) and shed `│┃` box chrome (`stripBoxChrome`); option scans anchor on the "1." row closest above the footer and abort on out-of-sequence numbers so prose/diff lists can't become clickable options. Buttons deliberately degrade to "answer in the terminal" rather than sending blind digits.
8b. **Every card button re-verifies the live screen at click time before writing to the PTY.** Question-card options and Review⇥ go through `cardMenuLive` (screen cards must still match the rendered menu's question+labels; transcript cards need `menuOnScreen`); prompt-card quick keys require `state === 'attention'` plus `promptVisibleOnScreen`; single-select cards lock after one send (`card.dataset.sent`, self-expires); options ≥ 10 are disabled (two-keystroke digits would actuate option 1); `typePrompt`'s delayed Enter and `confirmSubmit` wait a menu out instead of actuating it. A stale click must never inject keys into a menu or turn it wasn't aimed at — keep this property when touching any card handler. Stranded transcript questions (a `tool_use` whose result never lands) age out via `syncQuestionExpiry` instead of pinning attention/composer-lock forever; pane death clears all pending-question state.
9. **Never `innerHTML` user/agent text.** User strings always go through `textContent`; markdown goes through the in-house `markdownToHtml` whose `escapeHtml` escapes quotes for attribute safety. Keep it that way.
10. **Sidebar panels are mutually exclusive** — a new docked panel must close the others in its `setXOpen` and be closed by theirs, plus toggle a `sidebar` class, disable its toggle in `showEmpty`, and refresh in `selectBoard` via an `xOnBoardChange` hook.
11. **`chatIngest` is suppressed while viewing history** (`c.viewingHistory`) — anything that must never miss a transcript entry (plan detection, cost) runs *before* it in the `transcript.onEntries` handler.
12. **`upsertChatRow` keys rows by transcript uuid** so re-emitted lines update in place; re-renders must preserve open `<details>` folds and clicked-option echoes (see `addQuestionRow`'s `prevSel` logic) — a naive re-render loses in-flight interaction state.
13. **Concurrent edits**: the user's own Hivemind threads edit this repo in parallel (see memory). Re-read files before editing; on-disk stores (`todos.json`, `prompt-history.json`) are re-read before append precisely because another thread may have written them.
14. **Escape handling is centralized** for backdrop modals in one document listener (~`renderer.js:8143`) with an explicit priority chain; non-modal panels (hm-chat, find bar) handle Esc locally with `stopPropagation`. A new modal must be added to that chain.
15. Themes: `THEME` is **mutated in place** by `applyTheme` so new terminals pick up the current palette from the shared object — replace its contents, don't reassign it.

## How to extend

**Add a toolbar button** (board bar): add the `<button id="my-btn">` in `index.html` next to `#settings-btn`, style it (`.icon-btn` or `.pill-btn` in styles.css), then wire it near the other toolbar wiring (`renderer.js:~10040`): `const b = $('my-btn'); if (b) b.onclick = …`. If it should be disabled with no hive open, disable it in `showEmpty` and enable it in `selectBoard`. For a per-thread header button, instead create it inside `createPane`, append it into `header.append(...)`, add `mousedown` `stopPropagation` (so clicking doesn't steal focus) and remember narrow panes hide low-priority header controls via CSS. **Update the Help modal.**

**Add a keyboard shortcut**: for a global shortcut, add a capture-phase `document.addEventListener('keydown', …, true)` near the pane-navigation block (`renderer.js:~5339`), guard against typing in editable fields the way that block does (`xterm-helper-textarea` and `chat-input` count as pane, not field), and call `e.preventDefault(); e.stopImmediatePropagation()`. For a shortcut that must work inside terminals, add it to the single `attachCustomKeyEventHandler` in `createPane` instead. **Add it to the Shortcuts list in `#help-modal`.**

**Add a settings field**: (1) add the control to the right `.settings-panel` in `index.html`; (2) add a `let mySetting = localStorage.getItem('hm.mySetting') …` near the related feature; (3) populate it in `syncGeneralFields`/`syncVoiceFields`; (4) wire its `change` handler near `renderer.js:~10055` to update the variable and `localStorage.setItem`. Use the `hm.` key prefix. Per-thread settings instead go through `createPane` opts + `serializeLayout`/`rebuildFromLayout` so they persist in the layout. **Document it in Help.**

**Add a new modal**: copy the pattern — in `index.html`: `<div id="x-backdrop" class="hidden"><div id="x-modal">…</div></div>` with a `.settings-head` header and ✕ button; in styles.css reuse the settings-modal look (see the Usage/Help modals); in renderer.js: `openX()`/`closeX()` toggling `hidden`, a backdrop `mousedown` self-target close, and an entry in the global Escape chain at `renderer.js:~8143` (mind the priority order). If Hivemind commands should open it, add an `HM_COMMANDS` entry (with a `help` string, which auto-documents it).

**Add a Hivemind command**: append an entry `{ name, patterns: [regex…], help: '<strong>…</strong>', run(m, { board, pane }) { … } }` to `HM_COMMANDS` at the right position (specific before generic; before `task-in-thread`/`find`). `help: null` hides it from the Help list (use when a sibling documents it). Toast results with `hmToast(msg[, 'err'])` — it auto-mirrors into the Chat-with-Hivemind panel.

**Add a docked sidebar panel**: copy the Prompt History panel — `<aside id="x-panel">` in `index.html` with a `.git-header`, a toggle button in `.sidebar-actions`; in renderer.js a `setXOpen(open)` that closes all sibling panels (and is called by each of theirs), toggles `sidebar.classList` (add the matching `.x-open` CSS), `xOnBoardChange()` called from `selectBoard`, and disable/hide handling in `showEmpty`.
