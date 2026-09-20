// Bumped whenever the proxy gains or changes a route the page depends on. The page compares it
// with the version it was built against: `npm start` reads dist/ from disk on every request but
// loads the proxy code once, so after a rebuild a long-running process serves a new page with old
// routes. This turns that into a clear "restart the server" instead of a mysterious 404.
//
//   2  /api/generate (custom algorithms), optionIds on /api/llm
//   3  /api/duel/* (code duel), agents in /api/config
//   4  /api/duel/check (Settings checks an agent)
//   5  /api/auth, /api/login, /api/logout: everything else needs the admin password
export const API_VERSION = 5;
