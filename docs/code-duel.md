# Code duel

Every other game hands each player a `DecisionRequest`; this one has no moves to pick, so models, Jev
and the bots cannot sit down. It is a person against a code agent, and the match lives on the server
(`server/duel.mjs`), because both sides' work is files on disk and running tests. Today the agent is Qoder
CLI, on `Qwen3.8-Max` by default or `Qwen3.8-Flash`, `Kimi-K3`, `DeepSeek-Flash`. The other seat can
also be left empty: **practice** is the same card and the same clock with nobody to race, and it needs
no CLI installed at all.

## Cards

- Every card is an environment of its own, a directory under `challenges/` whose name is the
  card's id. `card.json` is what the page shows, plus what the server needs: `files` (everything the
  person is shown), `publicTest` (the repository's own tests, which are shown but read-only),
  `open`, `hiddenTests` (the title of every hidden test and which task or example asks for it),
  and `test`, which is `node` (`node --test`, nothing to install) or `ava`. `hidden.test.js` is the
  acceptance test. `start/` is the repository both sides start from. All but one are one source file
  and one test file with no dependencies; `04-emoji` is a snapshot of
  [sindresorhus/slugify](https://github.com/sindresorhus/slugify) with lint removed, so `npm test`
  is ava alone, about 3 s, and its dependencies are installed the first time anyone plays it.
- A card has a `level`, shown as a badge wherever the card is and used to group the setup page.
  Level 1 (`01`–`03`) is a fix of a line or two with a hint that names the edit, 2 minutes.
  Level 2 (`04`–`06`) is a small piece of logic, 3 minutes. Level 3 (`07`–`10`) is a function body
  whose edge cases are the work, 5 minutes. Picking a card sets its level's time
  limit, and from level 2 up the hint is folded away until asked for. Every card has a
  `TODO(card)` comment where the work goes, and the repository's own tests are red on the start,
  so ⌘/Ctrl+S says something from the first press.
- The hidden test asks only for what the card's tasks and examples show. `tests/duel.test.ts`
  checks that every example is in it, that every hidden test is declared in `hiddenTests` by the
  name the runner prints, and that each one names the task or example that asks for it. The agent's
  prompt is built from the same card, hint included, so neither side knows more than the other.

## How a duel runs

- Starting a duel makes clean copies in the system temp directory, one per side. The person's
  copy is edited through the page (CodeMirror; ⌘/Ctrl+S runs the repository's own tests,
  ⌘/Ctrl+Enter submits). The repository's own tests are shown in a locked tab: both sides read
  them, neither rewrites them, and they are restored from the card before any verdict. The agent's
  CLI is started in the other copy when the countdown ends — after its head start, if one was set —
  and its thoughts, words and tool calls stream to the page as it works.
- A side's time runs until it says "done": the person presses Submit, the agent's process exits.
  Verifying copies the hidden test in, runs it with the repository's own tests, and removes it
  again. That time is off **that side's** clock, the time limit included, so a verdict that comes
  back red hands the person the rest of their time rather than quietly spending it. A pass does not
  win while the other side said "done" earlier and is still being verified. A person who fails may
  fix and submit again; the agent gets one verdict. When the limit is reached the agent is killed,
  and with no pass nobody wins.
- A pass is not an exit code. Both runners are asked for TAP, and a submission passes only when
  every hidden test the card names is there by name and green, with nothing red. An exit code on
  its own would hand the match to a `process.exit(0)` at the top of the file.
- A failed verdict says how many tests passed, how many failed and which ones by name. When the
  duel is over, the page shows what each side wrote, as a patch, side by side.
- The fastest pass on each card is remembered in the browser and shown on the card.
- One duel at a time: starting one, stopping, leaving the page or stopping the server kills the
  agent of the previous one (its whole process group; on Windows, its process tree via `taskkill`) and removes its run directory. A tab that
  closes says so with a beacon; a page that simply stops asking loses its duel after 90 s.

## Adding an agent or a card

To add a code agent, add one entry to `server/agents.mjs`: its binary, the models it offers (the
first is the default), the arguments that run it headless on a prompt, and a function that turns a
line of its output into log entries. `readStreamJson` already reads Claude-Code-style `stream-json`.
The setup page, the player and the server pick it up from there. To add a card, add a directory
with those three things — and list its hidden tests in `hiddenTests`, or nothing it asks for counts.

## Keep it local

The duel routes write files and run what was written, and the agent runs with its permission
prompts off, so they answer only requests whose `Host` is this machine and whose `Origin`, if any,
matches it. That stops another website, or a rebound DNS name, from driving them. Both servers bind
`127.0.0.1`. It is still a local tool: anything that can set its own headers gets to run code here,
so do not expose it.

A deployment that wants the duel anyway lists its public host names in `DUEL_HOSTS`
(`play.example.com,other.example.com`). The origin check still applies, and `ADMIN_PASSWORD` is then
the only thing between a visitor and a shell: change it, and run the server as a user with nothing
to lose.

Measured on 2026-09-20 with the emoji card (a two-line fix), when its prompt also asked for readme
and test updates: `Qwen3.8-Max` had the fix in after 77 s but was still on the readme and tests
when the 3-minute limit killed it; each of its turns took about 10 s. A person who knows where to
look passes in under a minute. The prompt no longer asks for more than the card does, and a head
start of 15 to 60 seconds is there for when it is still not much of a race.
