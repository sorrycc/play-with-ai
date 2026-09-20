# Contributing

## The file map

```
server/api.mjs           the proxy: /api/config, /api/models, /api/llm, /api/generate, /api/jev
server/index.mjs         standalone server for a built site
vite.config.ts           mounts the same proxy inside the dev server
src/core/types.ts        Player, DecisionRequest, Decision, stats, seeded RNG
src/core/i18n.ts         every UI string, in zh (default) and en
src/core/sound.ts        synthesized sound effects and the mute setting
src/core/settings.ts     per-browser preferences: which games the home page shows, and their order
src/players/             llm (ZenMux), jev (TypeSafe), and the registry with bot / random / human
                         custom algorithms: algos (library), generate (prompt, trial, repair),
                         algoGames (per-game data docs and test positions), sandbox (the Worker)
src/games/tetris/        engine, real-time match, canvas drawing, arena
src/games/gomoku/        engine (shapes, candidates, bot), turn-based match, arena
src/games/snake/         two-snake engine (move facts, bot), fixed-tick match, canvas drawing, arena
src/games/g2048/         engine (slides, facts, expectimax bot), race match, arena with sliding tiles
src/games/chess/         full-rules engine (perft-verified), SAN, move facts, alpha-beta bot, match, arena
src/games/xiangqi/       full-rules engine (perft-verified), traditional notation, facts, bot, match, arena
src/ui/                  lobby, settings, seat setup, shared pieces, match lifecycle hook
tests/                   engines, request builders, answer parsing, a full scripted match
```

## Adding a game

1. `src/games/<name>/engine.ts`: pure rules, legal moves, a word description of each move, a bot.
2. `src/games/<name>/match.ts`: a class with `start()` / `stop()` that builds a `DecisionRequest`
   each turn (words for models in `options`, numbers for code in `data`) and applies the chosen
   option id. Describe the `data` fields in `src/players/algoGames.ts` so custom algorithms work.
3. `src/games/<name>/<Name>Arena.tsx`: renders the match; `useMatch` handles countdown and cleanup.
4. Add it to `GAMES` in `src/ui/Lobby.tsx`, its options to `src/ui/Setup.tsx`, and the arena to the
   switch in `src/App.tsx`.
5. Put its text in both dictionaries in `src/core/i18n.ts` (the `en` one is type-checked against
   `zh`, so a missing key fails `npm run typecheck`). Matches emit plain events; the arena maps them
   to sounds.

No player needs to change. Adding a role is the mirror image: one entry in `ROLES` and one case in
`createPlayer` (`src/players/index.ts`), and no game needs to change.

## Installs

`.npmrc` pins `registry.npmjs.org`, here and in the duel's slugify repository, so an install does
not depend on whatever registry the machine defaults to.
