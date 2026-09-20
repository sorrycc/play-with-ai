import { describe, expect, it } from 'vitest';
import { settings, sortGames } from '../src/core/settings';

describe('settings', () => {
  it('shows every game by default, hides and restores one, and notifies subscribers', () => {
    expect(settings.get().hiddenGames).toEqual([]);
    let calls = 0;
    const unsubscribe = settings.subscribe(() => calls++);

    const before = settings.get();
    settings.setGameVisible('snake', false);
    expect(settings.get().hiddenGames).toEqual(['snake']);
    // A new object each time: useSyncExternalStore compares snapshots by identity.
    expect(settings.get()).not.toBe(before);

    settings.setGameVisible('snake', false);
    expect(settings.get().hiddenGames).toEqual(['snake']);

    settings.setGameVisible('gomoku', false);
    settings.setGameVisible('snake', true);
    expect(settings.get().hiddenGames).toEqual(['gomoku']);

    settings.showAllGames();
    expect(settings.get().hiddenGames).toEqual([]);
    expect(calls).toBe(5);

    unsubscribe();
    settings.setGameVisible('tetris', false);
    expect(calls).toBe(5);
    settings.showAllGames();
  });

  it('reorders games, and a game the saved order has never heard of goes last', () => {
    const all = [{ id: 'tetris' }, { id: 'gomoku' }, { id: 'snake' }, { id: '2048' }, { id: 'chess' }] as const;
    const ids = () => sortGames([...all], settings.get().gameOrder).map((g) => g.id);
    expect(ids()).toEqual(['tetris', 'gomoku', 'snake', '2048', 'chess']);

    settings.moveGame(ids(), 'chess', 0);
    expect(ids()).toEqual(['chess', 'tetris', 'gomoku', 'snake', '2048']);
    settings.moveGame(ids(), 'tetris', 2);
    expect(ids()).toEqual(['chess', 'gomoku', 'tetris', 'snake', '2048']);
    settings.moveGame(ids(), '2048', 99); // past the end: clamped
    expect(ids()).toEqual(['chess', 'gomoku', 'tetris', 'snake', '2048']);

    // An order saved before snake and 2048 existed: they keep their relative place, after the rest.
    expect(sortGames([...all], ['chess', 'tetris', 'gomoku']).map((g) => g.id)).toEqual(['chess', 'tetris', 'gomoku', 'snake', '2048']);

    // Hiding and ordering are independent.
    settings.setGameVisible('gomoku', false);
    expect(ids()).toEqual(['chess', 'gomoku', 'tetris', 'snake', '2048']);
    settings.showAllGames();

    settings.resetGameOrder();
    expect(ids()).toEqual(['tetris', 'gomoku', 'snake', '2048', 'chess']);
  });
});
