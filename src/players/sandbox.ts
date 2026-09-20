// Runs a generated algorithm. The code was written by a language model, so it is treated as
// untrusted: it runs in its own Web Worker, where
//
//   - it has no DOM, no cookies and no access to this page's variables or localStorage;
//   - the ways to reach the network are removed before it starts, so it cannot call the /api proxy
//     (which would spend the owner's credit) or anything else;
//   - a call that takes too long kills the worker, so an endless loop costs one move, not the page.
//
// This is containment for buggy or careless code on a local site, not a hardened sandbox against a
// determined attacker; the code is also shown to the person before they use it.

import type { AlgoInput } from '../core/types';

/** Removed from the worker's global object and from every prototype behind it. */
const FORBIDDEN = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'Notification'];

const PRELUDE = `
"use strict";
(() => {
  for (const name of ${JSON.stringify(FORBIDDEN)}) {
    for (let o = self; o; o = Object.getPrototypeOf(o)) { try { delete o[name]; } catch {} }
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
})();
`;

/** Wraps the generated code so that only `choose` escapes it, then answers one message per move. */
export function workerSource(code: string): string {
  return `${PRELUDE}
const __choose = (function () {
  "use strict";
  ${code}
  ;return typeof choose === "function" ? choose : null;
})();
self.onmessage = (event) => {
  const { n, game } = event.data;
  try {
    if (!__choose) throw new Error("the code does not define a function named choose");
    const id = __choose(game);
    self.postMessage({ n, id: id === undefined || id === null ? null : String(id) });
  } catch (error) {
    self.postMessage({ n, error: String(error && error.message ? error.message : error) });
  }
};
`;
}

export interface AlgoRunner {
  /** The chosen option id. Rejects when the code throws, times out or returns nothing. */
  run(game: AlgoInput): Promise<string>;
  dispose(): void;
}

export const MOVE_TIMEOUT_MS = 1500;
const IDLE_MS = 30_000;

/** One worker per player, kept between moves (an algorithm may remember things) and dropped when idle. */
export function createWorkerRunner(code: string, timeoutMs = MOVE_TIMEOUT_MS): AlgoRunner {
  let worker: Worker | null = null;
  let url: string | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const dispose = () => {
    clearTimeout(idle);
    worker?.terminate();
    worker = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  };

  return {
    dispose,
    run(game) {
      clearTimeout(idle);
      if (!worker) {
        url = URL.createObjectURL(new Blob([workerSource(code)], { type: 'text/javascript' }));
        worker = new Worker(url);
      }
      const current = worker;
      const n = ++seq;
      return new Promise<string>((resolve, reject) => {
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          current.removeEventListener('message', onMessage);
          current.removeEventListener('error', onError);
          idle = setTimeout(dispose, IDLE_MS);
          fn();
        };
        const onMessage = (event: MessageEvent) => {
          if (event.data?.n !== n) return;
          if (event.data.error) finish(() => reject(new Error(event.data.error)));
          else if (typeof event.data.id !== 'string') finish(() => reject(new Error('choose() returned nothing')));
          else finish(() => resolve(event.data.id));
        };
        // A syntax error in the generated code surfaces here, before any message.
        const onError = (event: ErrorEvent) => finish(() => reject(new Error(event.message || 'the code failed to load')));
        const timer = setTimeout(() => {
          // The only way to stop a loop is to kill the worker; the next move starts a fresh one.
          dispose();
          finish(() => reject(new Error(`no answer within ${timeoutMs} ms`)));
        }, timeoutMs);
        current.addEventListener('message', onMessage);
        current.addEventListener('error', onError);
        current.postMessage({ n, game });
      });
    },
  };
}

/**
 * The same contract without a Worker, for tests (Node has no Worker of this kind). No isolation
 * and no timeout: never use it on code that has not already been vetted.
 */
export function createInlineRunner(code: string): AlgoRunner {
  const choose = new Function(`"use strict"; ${code}\n;return typeof choose === "function" ? choose : null;`)() as ((game: AlgoInput) => unknown) | null;
  return {
    dispose() {},
    async run(game) {
      if (!choose) throw new Error('the code does not define a function named choose');
      const id = choose(structuredClone(game));
      if (id === undefined || id === null) throw new Error('choose() returned nothing');
      return String(id);
    },
  };
}
