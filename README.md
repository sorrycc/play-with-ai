# Play with AI

An arcade where AI models, Jev, classic algorithms, code agents and people play games against each
other. Any role can take any seat: AI vs AI, you vs AI, you vs a friend.

- **Tetris**: real-time duel, same pieces, cleared rows send garbage. Latency is part of the game.
- **五子棋 Gomoku**: 15×15, five in a row. Turn-based, so only judgment counts.
- **贪吃蛇 Snake**: two snakes on one grid, moving at once. Length is the score; the walls close in.
- **2048**: a race on two boards from one opening. Higher score wins when the clock runs out.
- **国际象棋 Chess** / **中国象棋 Xiangqi**: full rules, FEN/PGN, traditional notation, 长将 loses.
- **代码对决 Code Duel**: you against Qoder CLI. First to pass the card's hidden test wins.

The UI is Chinese by default, English one click away (中/EN). What a model reads stays English.
The idea and the Tetris engine come from [trungdq88/jev-tetris](https://github.com/trungdq88/jev-tetris).

## Run it

Requires Node.js 20.6 or newer.

```sh
cp .env.example .env      # ADMIN_PASSWORD (login), ZENMUX_API_KEY (AI model), TYPESAFE_API_KEY (Jev)
npm install
npm run dev               # http://127.0.0.1:5173
npm test                  # no network
```

A role whose key is missing is greyed out. Keys stay in the proxy (`server/api.mjs`). The code duel
needs `qodercli` on the `PATH`, signed in; practice mode needs nothing. `npm run build && npm start`
serves the built site. The page asks for `ADMIN_PASSWORD` (12306 when unset) before any other API
route answers, so change it before going public: anyone who gets in spends your ZenMux credit.

## How it works

Code owns the game; a player only picks. Each game enumerates its legal moves and describes every
outcome in words. Every role (🤖 AI model, ⚡ Jev, 🧑‍🚀 you, 🧮 classic bot, ✨ custom algorithm,
🐒 chaos monkey, 👾 code agent) gets the same `DecisionRequest` and returns one option id, so an
illegal move cannot happen. Custom algorithms are model-written, so they run in a Web Worker with no
network and a 1.5 s limit.

Docs: [Internals](docs/internals.md) · [Code duel](docs/code-duel.md) · [Contributing](docs/contributing.md)

## License

[MIT](LICENSE)
