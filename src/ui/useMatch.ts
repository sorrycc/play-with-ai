import { useCallback, useEffect, useState } from 'react';
import { sfx } from '../core/sound';

interface Runnable {
  start(): void;
  stop(): void;
}

const STEP_MS = 650;

/**
 * Owns one match for the life of the component: builds it, counts "3, 2, 1, GO!", starts it, and
 * stops it on unmount so no model call outlives the page. A rematch is a remount (new `key`).
 *
 * `create` gets an `onChange` that re-renders the component; it is read once, on mount.
 *
 * With `wait`, the count does not begin until `begin()` is called: a game that first shows a
 * person how to play holds the match in `waiting` for as long as they read.
 */
export function useMatch<M extends Runnable>(create: (onChange: () => void) => M, { wait = false }: { wait?: boolean } = {}): { match: M | null; count: number | null; waiting: boolean; begin: () => void } {
  const [match, setMatch] = useState<M | null>(null);
  const [waiting, setWaiting] = useState(wait);
  const [count, setCount] = useState<number | null>(wait ? null : 3);
  const [, setTick] = useState(0);
  const begin = useCallback(() => setWaiting(false), []);

  useEffect(() => {
    const m = create(() => setTick((t) => t + 1));
    setMatch(m);
    return () => m.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!match || waiting) return;
    const m = match;
    setCount(3);
    const tick = (n: number) => {
      setCount(n);
      sfx.play('count');
    };
    sfx.play('count');
    const timers = [
      setTimeout(() => tick(2), STEP_MS),
      setTimeout(() => tick(1), STEP_MS * 2),
      setTimeout(() => {
        setCount(0);
        sfx.play('go');
        m.start();
      }, STEP_MS * 3),
      setTimeout(() => setCount(null), STEP_MS * 4),
    ];
    return () => timers.forEach(clearTimeout);
  }, [match, waiting]);

  return { match, count, waiting, begin };
}
