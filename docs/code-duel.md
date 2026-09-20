# Code duel

Every other game hands each player a `DecisionRequest`; this one has no moves to pick, so models, Jev
and the bots cannot sit down. It is a person against a code agent, and the match lives on the server
(`server/duel.mjs`), because both sides' work is files on disk and running tests. Today the agent is Qoder
CLI, on `Qwen3.8-Max` by default or `Qwen3.8-Flash`, `Kimi-K3`, `DeepSeek-Flash`.

## Cards

- Every card is an environment of its own, a directory under `challenges/` whose name is the
  card's id. `card.json` is what the page shows, plus what the server needs: `files` (what the
  person may edit), `publicTest`, `open`, and `test`, which is `node` (`node --test`, nothing to
  install) or `ava`. `hidden.test.js` is the acceptance test. `start/` is the repository both sides
  start from. All but one are one source file and one test file with no dependencies; `04-emoji`
  is a snapshot of [sindresorhus/slugify](https://github.com/sindresorhus/slugify) with lint
  removed, so `npm test` is ava alone, about 3 s, and its dependencies are installed the first time
  anyone plays it.
- A card has a `level`, shown as a badge wherever the card is and used to group the setup page.
  Level 1 (`01`–`03`) is a fix of a line or two with a hint that names the edit, 2 minutes.
  Level 2 (`04`–`06`) is a small piece of logic, 3 minutes. Level 3 (`07-intervals`, `08-lru`) is
  a function body whose edge cases are the work, 5 minutes. Picking a card sets its level's time
  limit, and from level 2 up the hint is folded away until asked for. Every card has a
  `TODO(card)` comment where the work goes. The hidden test asks only for
  what the card's tasks and examples show (`tests/duel.test.ts` checks that every example is in
  it), and the agent's prompt is built from the same card, hint included, so neither side knows
  more than the other.

## How a duel runs

- Starting a duel makes two clean copies in the system temp directory, one per side. The person's
  copy is edited through the page (CodeMirror; ⌘/Ctrl+S runs the repository's own tests,
  ⌘/Ctrl+Enter submits). The agent's CLI is started in the other copy when the countdown ends, and
  its thoughts, words and tool calls stream to the page as it works.
- A side's time runs until it says "done": the person presses Submit, the agent's process exits.
  Verifying copies the hidden test in, runs it with the repository's own tests, and removes it
  again; that time is off the clock, and a pass does not win while the other side said "done"
  earlier and is still being verified. A person who fails may fix and submit again; the agent gets
  one verdict. When the limit is reached the agent is killed, and with no pass nobody wins.
- One duel at a time: starting one, stopping, leaving the page or stopping the server kills the
  agent of the previous one (its whole process group).

## Adding an agent or a card

To add a code agent, add one entry to `server/agents.mjs`: its binary, the models it offers (the
first is the default), the arguments that run it headless on a prompt, and a function that turns a
line of its output into log entries. `readStreamJson` already reads Claude-Code-style `stream-json`.
The setup page, the player and the server pick it up from there. To add a card, add a directory
with those three things.

## Keep it local

The duel routes write files and run what was written, and the agent runs with its permission
prompts off, so they answer only requests whose `Host` is this machine and whose `Origin`, if any,
matches it. That stops another website, or a rebound DNS name, from driving them. It is still a
local tool: do not expose it.

Measured on 2026-09-20 with the emoji card (a two-line fix), when its prompt also asked for readme
and test updates: `Qwen3.8-Max` had the fix in after 77 s but was still on the readme and tests
when the 3-minute limit killed it; each of its turns took about 10 s. A person who knows where to
look passes in under a minute. The prompt no longer asks for more than the card does.
