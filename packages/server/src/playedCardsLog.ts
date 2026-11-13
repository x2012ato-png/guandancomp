import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cardLabel, rankLabel, suitLabel, type ComboType, type GameEvent, type ScopedEvent, type Seat } from '@guandan/engine';

const DEFAULT_PATH = fileURLToPath(new URL('../../../played_cards_log.md', import.meta.url));
const COMBO_LABELS: Record<ComboType, string> = {
  single: '单张', pair: '对子', triple: '三张', fullHouse: '三带二', straight: '顺子',
  tube: '连对', plate: '钢板', bomb: '炸弹', straightFlush: '同花顺', jokerBomb: '天王炸',
};

type LogSeat = { readonly nickname: string } | null;
const escapeMarkdown = (value: string) => value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');

/** One file for the current hand. Calls are synchronous so event order matches game commits. */
export class PlayedCardsLog {
  private sequence = 0;
  private readonly path: string;

  constructor(path = process.env.GUANDAN_PLAYED_CARDS_LOG || DEFAULT_PATH) { this.path = path; }

  read(): string { return readFileSync(this.path, 'utf8'); }

  record(roomId: string, seats: readonly LogSeat[], events: readonly ScopedEvent[]): void {
    const player = (seat: Seat) => `${escapeMarkdown(seats[seat]?.nickname ?? '未知玩家')}（座位 ${seat}）`;
    const lines: string[] = [];
    let reset = false;
    for (const scoped of events) {
      // A shared log must never reveal an event that is private to certain seats.
      const event = scoped.visibleTo === 'all' ? scoped.event : scoped.redacted;
      if (!event) continue;
      if (event.type === 'handStarted') {
        reset = true;
        this.sequence = 0;
        lines.push(`# 出牌记录：第 ${event.handNo} 局`, '', `- 房间：${escapeMarkdown(roomId)}`,
          `- 开始时间：${new Date().toISOString()}`, `- 级牌：${rankLabel(event.level)}`,
          `- 座位（0、2 为一队；1、3 为一队）：${([0, 1, 2, 3] as const).map(player).join('、')}`,
          '', '## 游戏过程', '');
        continue;
      }
      const detail = this.describe(event, player);
      if (detail) lines.push(`${++this.sequence}. ${detail}`);
    }
    if (!lines.length) return;
    const content = `${lines.join('\n')}\n`;
    if (reset) writeFileSync(this.path, content, 'utf8');
    else appendFileSync(this.path, content, 'utf8');
  }

  private describe(event: GameEvent, player: (seat: Seat) => string): string | null {
    switch (event.type) {
      case 'played': {
        const { play } = event;
        const cards = play.cards.map(card => `${cardLabel(card)}（ID ${card}）`).join('、');
        const wilds = play.wildAssignments.map(w => `${cardLabel(w.cardId)}（ID ${w.cardId}）→${suitLabel(w.suit)}${rankLabel(w.rank)}`).join('、');
        return `${player(event.seat)} 出牌：${cards}；牌型：${COMBO_LABELS[play.combo.type]}（${play.combo.type}，比较值 ${play.combo.key}）${wilds ? `；逢人配：${wilds}` : ''}`;
      }
      case 'passed': return `${player(event.seat)} 不要`;
      case 'trickWon': return `${player(event.seat)} 赢得本轮；${player(event.leader)} ${event.jiefeng ? '接风首出' : '下轮首出'}`;
      case 'playerFinished': return `${player(event.seat)} 出完，排名第 ${event.place}`;
      case 'antiTribute': return `${event.seats.map(player).join('、')} 抗贡`;
      case 'tributeRequired': return `${event.payers.map(player).join('、')} 需要进贡`;
      case 'tributePaid': return `${player(event.from)} 进贡 ${cardLabel(event.card)}（ID ${event.card}）`;
      case 'tributeAssigned': return event.links.map(link => `${player(link.from)} 向 ${player(link.to)} 进贡 ${cardLabel(link.card)}（ID ${link.card}）`).join('；');
      case 'tributeReturned': return `${player(event.from)} 向 ${player(event.to)} 还贡${event.card === null ? '（牌面未公开）' : ` ${cardLabel(event.card)}（ID ${event.card}）`}`;
      case 'handOver': return `本局结束：${event.result.finishOrder.map(player).join(' → ')}；队伍 ${event.result.winTeam} 升 ${event.result.upgrade} 级`;
      case 'matchOver': return `比赛结束：队伍 ${event.winner} 获胜`;
      case 'handStarted': return null;
    }
  }
}
