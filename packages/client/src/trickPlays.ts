import { cardOf, rankPower, type CardId, type Level, type Play, type Seat, type TrickState } from '@guandan/engine';

/** Arrange substituted cards by their role in the combination, without changing the play. */
export function displayPlayCards(play: Play, level: Level): CardId[] {
  if (!play.wildAssignments.length) return [...play.cards];
  const assignments = new Map(play.wildAssignments.map(assignment => [assignment.cardId, assignment.rank]));
  const rank = (card: CardId) => assignments.get(card) ?? cardOf(card).rank;
  const { type, key } = play.combo;
  if (type === 'fullHouse') {
    return [...play.cards].sort((a, b) => Number(rankPower(rank(b), level) === key) - Number(rankPower(rank(a), level) === key));
  }
  if (type === 'straight' || type === 'straightFlush' || type === 'tube' || type === 'plate') {
    const lowAce = key === (type === 'tube' ? 3 : type === 'plate' ? 2 : 5);
    const sequenceRank = (card: CardId) => lowAce && rank(card) === 14 ? 1 : rank(card);
    return [...play.cards].sort((a, b) => sequenceRank(a) - sequenceRank(b));
  }
  return [...play.cards];
}

/** The most recent cards each seat played in the current trick. */
export function trickPlaysBySeat(trick: TrickState | null, playing: boolean): Partial<Record<Seat, Play>> {
  const plays: Partial<Record<Seat, Play>> = {};
  if (playing) {
    for (const entry of trick?.history ?? []) {
      if (entry.play) plays[entry.seat] = entry.play;
    }
  }
  return plays;
}

/** Seats whose latest action in the current trick was a pass. */
export function trickPassesBySeat(trick: TrickState | null, playing: boolean): Partial<Record<Seat, boolean>> {
  const passes: Partial<Record<Seat, boolean>> = {};
  if (playing) {
    for (const entry of trick?.history ?? []) passes[entry.seat] = entry.play === null;
  }
  return passes;
}
