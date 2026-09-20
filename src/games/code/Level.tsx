// A card's level, the same badge wherever a card is shown: on the setup page, on the task card
// during the duel, and in the result.

import { t, type TextKey } from '../../core/i18n';
import type { CardLevel } from './match';

export const LEVELS: Record<CardLevel, { name: TextKey; blurb: TextKey; color: string; /** The time limit a card of this level is picked with. */ limitSec: number }> = {
  1: { name: 'code.level.1', blurb: 'code.level.1.blurb', color: '#3ddc97', limitSec: 120 },
  2: { name: 'code.level.2', blurb: 'code.level.2.blurb', color: '#ffd23f', limitSec: 180 },
  3: { name: 'code.level.3', blurb: 'code.level.3.blurb', color: '#ff5d8f', limitSec: 300 },
};

export function LevelBadge({ level }: { level: CardLevel }) {
  const { name, color } = LEVELS[level];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border-2 border-ink px-2 py-0.5 text-xs font-bold leading-none ${level === 3 ? 'text-white' : ''}`} style={{ background: color }} title={t('code.difficulty')}>
      <span className="font-mono">Lv.{level}</span> {t(name)}
    </span>
  );
}
