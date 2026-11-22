/**
 * DanZero 深度蒙特卡洛（DMC）预训练价值网络（纯 TypeScript / Float32Array 原生推理）。
 *
 * 网络结构：
 *   567 -> 512 (Tanh) -> 512 (Tanh) -> 512 (Tanh) -> 512 (Tanh) -> 512 (Tanh) -> 1 (Identity)
 *
 * 直接在 Node.js 进程内加载 `packages/ai/weights/danzero_q_network.bin`，无需启动任何 Python 服务。
 * 额外优化：由于前 513 维特征是当前局面的状态特征（对所有候选动作相同），只有后 54 维是动作特征，
 * 第 1 层 `567 -> 512` 的前 513 维矩阵乘法只需每个回合计算 1 次，每个候选动作只需计算后 54 维中非零的 1~10 张牌！
 */
import {
  generatePlays,
  validReturnCards,
  validTributeCards,
  type CardId,
  type Play,
  type PlayerView,
} from '@guandan/engine';
import type { AIDecision, AIPolicy } from './types.ts';

interface Layer {
  readonly inDim: number;
  readonly outDim: number;
  readonly w: Float32Array;
  readonly b: Float32Array;
}

const LAYER_SHAPES: readonly [number, number][] = [
  [567, 512],
  [512, 512],
  [512, 512],
  [512, 512],
  [512, 512],
  [512, 1],
];

let cachedLayers: readonly Layer[] | null = null;
const nodeRequire = typeof process !== 'undefined' && process.versions?.node ? process.getBuiltinModule : undefined;

function loadLayers(): readonly Layer[] {
  if (cachedLayers) return cachedLayers;
  const fs = nodeRequire?.('node:fs') as typeof import('node:fs') | undefined;
  const path = nodeRequire?.('node:path') as typeof import('node:path') | undefined;
  const url = nodeRequire?.('node:url') as typeof import('node:url') | undefined;
  if (!fs || !path || !url) throw new Error('DanZero weights loading requires Node.js runtime');
  const dir = path.dirname(url.fileURLToPath(import.meta.url));
  const binPath = path.resolve(dir, '..', 'weights', 'danzero_q_network.bin');
  const buf = fs.readFileSync(binPath);
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const layers: Layer[] = [];
  let offset = 0;
  for (const [inDim, outDim] of LAYER_SHAPES) {
    const wLen = inDim * outDim;
    const w = floats.subarray(offset, offset + wLen);
    offset += wLen;
    const b = floats.subarray(offset, offset + outDim);
    offset += outDim;
    layers.push({ inDim, outDim, w, b });
  }
  cachedLayers = layers;
  return layers;
}

/**
 * 预计算第 0 层前 513 维状态特征的线性投影：`baseHidden512 = b0 + state513 @ w0[0..512]`。
 */
function computeStateBaseHidden(feature567: Int8Array, baseHidden512: Float32Array): void {
  const l0 = loadLayers()[0]!;
  const w0 = l0.w;
  baseHidden512.set(l0.b);
  for (let i = 0; i < 513; i++) {
    const x = feature567[i]!;
    if (x === 0) continue;
    const rowOffset = i * 512;
    if (x === 1) {
      for (let j = 0; j < 512; j++) baseHidden512[j]! += w0[rowOffset + j]!;
    } else if (x === -1) {
      for (let j = 0; j < 512; j++) baseHidden512[j]! -= w0[rowOffset + j]!;
    } else {
      for (let j = 0; j < 512; j++) baseHidden512[j]! += x * w0[rowOffset + j]!;
    }
  }
}

/**
 * 基于预计算好的 `baseHidden512`，仅叠加后 54 维候选动作特征并执行后续隐藏层推理。
 */
export function evaluateDanZeroActionQ(
  feature567: Int8Array,
  baseHidden512: Float32Array,
  scratchA: Float32Array,
  scratchB: Float32Array,
): number {
  const layers = loadLayers();
  const w0 = layers[0]!.w;
  scratchA.set(baseHidden512);

  // Only accumulate the non-zero action dims (indices 513..566, typically 0..10 non-zero entries)
  for (let i = 513; i < 567; i++) {
    const x = feature567[i]!;
    if (x === 0) continue;
    const rowOffset = i * 512;
    if (x === 1) {
      for (let j = 0; j < 512; j++) scratchA[j]! += w0[rowOffset + j]!;
    } else {
      for (let j = 0; j < 512; j++) scratchA[j]! += x * w0[rowOffset + j]!;
    }
  }
  for (let j = 0; j < 512; j++) scratchA[j] = Math.tanh(scratchA[j]!);

  // Layers 1..4: 512 -> 512 with Tanh
  let cur = scratchA;
  let next = scratchB;
  for (let l = 1; l <= 4; l++) {
    const layer = layers[l]!;
    const w = layer.w;
    next.set(layer.b);
    for (let i = 0; i < 512; i++) {
      const x = cur[i]!;
      const rowOffset = i * 512;
      for (let j = 0; j < 512; j++) {
        next[j]! += x * w[rowOffset + j]!;
      }
    }
    for (let j = 0; j < 512; j++) next[j] = Math.tanh(next[j]!);
    const tmp = cur;
    cur = next;
    next = tmp;
  }

  // Layer 5: 512 -> 1 (linear)
  const l5 = layers[5]!;
  const w5 = l5.w;
  let out = l5.b[0]!;
  for (let i = 0; i < 512; i++) {
    out += cur[i]! * w5[i]!;
  }
  return out;
}

/**
 * `@guandan/engine` CardId (0..107) -> DanZero CardNum (0..53).
 *
 * Engine CardId % 54:
 *   0..12:  S2..SA  -> DanZero 13..25
 *   13..25: H2..HA  -> DanZero 0..12
 *   26..38: C2..CA  -> DanZero 26..38
 *   39..51: D2..DA  -> DanZero 39..51
 *   52:     SB      -> DanZero 52
 *   53:     HR      -> DanZero 53
 */
export function cardIdToDanZeroNum(cardId: CardId): number {
  const i = cardId % 54;
  if (i < 13) return i + 13; // S -> 13..25
  if (i < 26) return i - 13; // H -> 0..12
  return i; // C (26..38), D (39..51), SB (52), HR (53)
}

/**
 * 将 DanZero 牌号列表转为 54 维 Fortran 列优先向量（与 `danutil.card2array` 完全一致）。
 *
 * 在 Fortran 顺序展开的 4x13 矩阵中：
 *   danzeroNum in 0..51: row = floor(num / 13) (0=H,1=S,2=C,3=D), col = num % 13 (0='2' .. 12='A')
 *   flattened index = col * 4 + row
 *   52 -> index 52 (SB), 53 -> index 53 (HR)
 */
export function card2arrayInto(nums: readonly number[], target: Int8Array, offset: number): void {
  target.fill(0, offset, offset + 54);
  if (nums.length === 0) return;
  if (nums.length === 1 && nums[0] === -1) {
    target.fill(-1, offset, offset + 54);
    return;
  }
  for (const card of nums) {
    if (card === -1) continue;
    if (card >= 0 && card < 52) {
      const row = Math.floor(card / 13);
      const col = card % 13;
      target[offset + col * 4 + row]!++;
    } else if (card === 52 || card === 53) {
      target[offset + card]!++;
    }
  }
}

/**
 * 与 `DanzeroAgent.proc_universal` 完全一致的 12 维逢人配特征。
 * @param handCards54 偏移 0..53 的 54 维手牌数组
 * @param curRankIdx 1..13 ('2'->1 .. 'A'->13)
 */
function procUniversalInto(handCards54: Int8Array, curRankIdx: number, target: Int8Array, offset: number): void {
  target.fill(0, offset, offset + 12);
  const wildPos = (curRankIdx - 1) * 4;
  if (handCards54[wildPos] === 0) return;

  target[offset] = 1;
  let rockFlag = 0;
  for (let i = 0; i < 4; i++) {
    let right = 5;
    const temp: number[] = [];
    for (let j = 0; j < 5; j++) {
      const pos = i + j * 4;
      temp.push(pos !== wildPos ? handCards54[pos]! : 0);
    }
    while (right <= 12) {
      let zeroNum = 0;
      for (const v of temp) if (v === 0) zeroNum++;
      if (zeroNum <= 1) {
        rockFlag = 1;
        break;
      }
      const nextPos = i + right * 4;
      temp.push(nextPos !== wildPos ? handCards54[nextPos]! : 0);
      temp.shift();
      right++;
    }
    if (rockFlag === 1) break;
  }
  target[offset + 1] = rockFlag;

  const numCount = new Int32Array(13);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 13; j++) {
      const pos = i + j * 4;
      if (handCards54[pos]! !== 0 && pos !== wildPos) {
        numCount[j]!++;
      }
    }
  }
  let numMax = 0;
  for (let j = 0; j < 13; j++) if (numCount[j]! > numMax) numMax = numCount[j]!;
  if (numMax >= 6) {
    for (let k = 2; k < 8; k++) target[offset + k] = 1;
  } else if (numMax === 5) {
    for (let k = 3; k < 8; k++) target[offset + k] = 1;
  } else if (numMax === 4) {
    for (let k = 4; k < 8; k++) target[offset + k] = 1;
  } else if (numMax === 3) {
    for (let k = 5; k < 8; k++) target[offset + k] = 1;
  } else if (numMax === 2) {
    for (let k = 6; k < 8; k++) target[offset + k] = 1;
  } else {
    target[offset + 7] = 1;
  }

  let tempRun = 0;
  for (let i = 0; i < 13; i++) {
    if (numCount[i]! !== 0) {
      tempRun++;
      if (i >= 1) {
        if ((numCount[i] === 2 && numCount[i - 1]! >= 3) || (numCount[i]! >= 3 && numCount[i - 1] === 2)) {
          target[offset + 9] = 1;
        } else if (numCount[i] === 2 && numCount[i - 1] === 2) {
          target[offset + 11] = 1;
        }
      }
      if (i >= 2) {
        if (
          (numCount[i - 2] === 1 && numCount[i - 1]! >= 2 && numCount[i]! >= 2) ||
          (numCount[i - 2]! >= 2 && numCount[i - 1] === 1 && numCount[i]! >= 2) ||
          (numCount[i - 2]! >= 2 && numCount[i - 1]! >= 2 && numCount[i] === 1)
        ) {
          target[offset + 10] = 1;
        }
      }
    } else {
      tempRun = 0;
    }
  }
  if (tempRun >= 4) target[offset + 8] = 1;
}

function withoutCards(hand: readonly CardId[], used: readonly CardId[]): CardId[] {
  const s = new Set(used);
  return hand.filter((c) => !s.has(c));
}

/**
 * 生成供 DanZero 评估的候选出牌列表（含同花顺保护替代以及单张/对子多花色展开）。
 */
function buildDanZeroCandidates(view: PlayerView): AIDecision[] {
  const toBeat = view.trick?.lastPlay?.play.combo;
  const plays = generatePlays(view.myHand, view.level, view.config, toBeat);
  const flushes = (toBeat ? generatePlays(view.myHand, view.level, view.config) : plays).filter(
    (p) => p.combo.type === 'straightFlush',
  );
  if (flushes.length) {
    const seen = new Set(
      plays.map((p) => `${p.combo.type}:${p.combo.key}:${p.combo.suit ?? ''}:${[...p.cards].sort((a, b) => a - b)}`),
    );
    for (const flush of flushes) {
      for (const play of generatePlays(withoutCards(view.myHand, flush.cards), view.level, view.config, toBeat)) {
        const key = `${play.combo.type}:${play.combo.key}:${play.combo.suit ?? ''}:${[...play.cards].sort((a, b) => a - b)}`;
        if (!seen.has(key)) {
          seen.add(key);
          plays.push(play);
        }
      }
    }
  }

  // 按自然点数分组手牌中的非逢人配牌，用于展开同点数不同花色的单张/对子候选
  const byRank = new Map<number, CardId[]>();
  for (const cid of view.myHand) {
    const i = cid % 54;
    if (i >= 52) continue;
    const suitIdx = Math.floor(i / 13); // 0=S, 1=H, 2=C, 3=D
    const rank = 2 + (i % 13);
    if (suitIdx === 1 && rank === view.level) continue; // wildcard
    const arr = byRank.get(rank);
    if (arr) arr.push(cid);
    else byRank.set(rank, [cid]);
  }

  const expanded: Play[] = [];
  for (const play of plays) {
    expanded.push(play);
    if (play.wildAssignments.length > 0) continue;
    if (play.combo.type === 'single' && play.cards.length === 1) {
      const i0 = play.cards[0]! % 54;
      if (i0 < 52) {
        const rank = 2 + (i0 % 13);
        const seenSuits = new Set<number>([Math.floor(i0 / 13)]);
        for (const altId of byRank.get(rank) ?? []) {
          const sIdx = Math.floor((altId % 54) / 13);
          if (!seenSuits.has(sIdx)) {
            seenSuits.add(sIdx);
            expanded.push({ ...play, cards: [altId] });
          }
        }
      }
    } else if (play.combo.type === 'pair' && play.cards.length === 2) {
      const i0 = play.cards[0]! % 54;
      const i1 = play.cards[1]! % 54;
      if (i0 < 52) {
        const rank = 2 + (i0 % 13);
        const pool = byRank.get(rank) ?? [];
        if (pool.length >= 3) {
          const seenPairs = new Set<string>([`${Math.min(i0, i1)},${Math.max(i0, i1)}`]);
          for (let a = 0; a < pool.length; a++) {
            for (let b = a + 1; b < pool.length; b++) {
              const ca = pool[a]!;
              const cb = pool[b]!;
              const sa = ca % 54;
              const sb = cb % 54;
              const sig = `${Math.min(sa, sb)},${Math.max(sa, sb)}`;
              if (!seenPairs.has(sig)) {
                seenPairs.add(sig);
                expanded.push({ ...play, cards: [ca, cb] });
              }
            }
          }
        }
      }
    }
  }

  const choices: AIDecision[] = expanded.map((play) => ({ type: 'play', play }));
  if (view.trick?.lastPlay) choices.push({ type: 'pass' });
  return choices;
}

/**
 * 填充除最后 54 维动作特征外的 513 维基础状态特征。
 */
export function encodeDanZeroState513(view: PlayerView, feature567: Int8Array): void {
  feature567.fill(0, 0, 513);
  const mySeat = view.seat;
  const downSeat = ((mySeat + 1) % 4) as 0 | 1 | 2 | 3;
  const teammateSeat = ((mySeat + 2) % 4) as 0 | 1 | 2 | 3;
  const upSeat = ((mySeat + 3) % 4) as 0 | 1 | 2 | 3;

  // 1. my_handcards (0..53)
  const myHandNums = view.myHand.map(cardIdToDanZeroNum);
  card2arrayInto(myHandNums, feature567, 0);

  // 2. universal_card_flag (54..65, 12 dims)
  const curRankIdx = Math.max(1, Math.min(13, view.level - 1));
  procUniversalInto(feature567, curRankIdx, feature567, 54);

  // 3. other_handcards (66..119, 54 dims)
  const otherLeftCounts = new Int32Array(54).fill(2);
  for (const cnum of myHandNums) otherLeftCounts[cnum] = Math.max(0, otherLeftCounts[cnum]! - 1);
  for (const cid of view.playedCards) {
    const cnum = cardIdToDanZeroNum(cid);
    otherLeftCounts[cnum] = Math.max(0, otherLeftCounts[cnum]! - 1);
  }
  const otherHandsList: number[] = [];
  for (let cnum = 0; cnum < 54; cnum++) {
    const cnt = otherLeftCounts[cnum]!;
    if (cnt === 1) otherHandsList.push(cnum);
    else if (cnt >= 2) otherHandsList.push(cnum, cnum);
  }
  card2arrayInto(otherHandsList, feature567, 66);

  // Reconstruct per-seat action history matching `DanzeroAgent.received_message()`
  const historyAction: Record<number, number[][]> = { 0: [], 1: [], 2: [], 3: [] };
  const actionSeq: number[][] = [];
  const publicHistory = view.publicHistory ?? [];

  if (publicHistory.length > 0) {
    for (let idx = 0; idx < publicHistory.length; idx++) {
      const entry = publicHistory[idx]!;
      const s = entry.seat;
      const actNums = entry.play === null ? [-1] : entry.play.cards.map(cardIdToDanZeroNum);
      historyAction[s]!.push(actNums);
      if (s !== mySeat) actionSeq.push(actNums);

      if (idx + 1 < publicHistory.length) {
        const nextS = publicHistory[idx + 1]!.seat;
        let cur = (s + 1) % 4;
        let stepsChecked = 0;
        while (cur !== nextS && stepsChecked < 3) {
          historyAction[cur]!.push([-1]);
          if (cur !== mySeat) actionSeq.push([-1]);
          cur = (cur + 1) % 4;
          stepsChecked++;
        }
      }
    }
    const lastS = publicHistory[publicHistory.length - 1]!.seat;
    let cur = (lastS + 1) % 4;
    let stepsChecked = 0;
    while (cur !== mySeat && stepsChecked < 3) {
      historyAction[cur]!.push([-1]);
      if (cur !== mySeat) actionSeq.push([-1]);
      cur = (cur + 1) % 4;
      stepsChecked++;
    }
  } else if (view.trick?.history?.length) {
    for (const entry of view.trick.history) {
      const s = entry.seat;
      const actNums = entry.play === null ? [-1] : entry.play.cards.map(cardIdToDanZeroNum);
      historyAction[s]!.push(actNums);
      if (s !== mySeat) actionSeq.push(actNums);
    }
  }

  // 4. last_action (120..173, 54 dims)
  if (actionSeq.length > 0) {
    const lastAct = actionSeq[actionSeq.length - 1]!;
    if (lastAct.length === 1 && lastAct[0] === -1) {
      card2arrayInto([], feature567, 120);
    } else {
      card2arrayInto(lastAct, feature567, 120);
    }
  } else if (view.trick?.lastPlay) {
    card2arrayInto(view.trick.lastPlay.play.cards.map(cardIdToDanZeroNum), feature567, 120);
  } else {
    card2arrayInto([-1], feature567, 120);
  }

  // 5. last_teammate_action (174..227, 54 dims)
  const teammateOut = view.finishOrder.includes(teammateSeat) || view.handCounts[teammateSeat] === 0;
  const tmHist = historyAction[teammateSeat]!;
  if (tmHist.length > 0 && !teammateOut) {
    card2arrayInto(tmHist[tmHist.length - 1]!, feature567, 174);
  } else {
    card2arrayInto([-1], feature567, 174);
  }

  // 6, 7, 8. down / teammate / up played cards (228..281, 282..335, 336..389)
  const encodeSeatHistory = (seatId: number, offset: number) => {
    const acts = historyAction[seatId]!;
    if (acts.length === 0) {
      card2arrayInto([], feature567, offset);
      return;
    }
    const flat: number[] = [];
    for (const a of acts) for (const x of a) flat.push(x);
    card2arrayInto(flat, feature567, offset);
  };
  encodeSeatHistory(downSeat, 228);
  encodeSeatHistory(teammateSeat, 282);
  encodeSeatHistory(upSeat, 336);

  // 9, 10, 11. down / teammate / up remaining cards count one-hot (28 dims each: 390..417, 418..445, 446..473)
  feature567[390 + Math.max(0, Math.min(27, view.handCounts[downSeat]))] = 1;
  feature567[418 + Math.max(0, Math.min(27, view.handCounts[teammateSeat]))] = 1;
  feature567[446 + Math.max(0, Math.min(27, view.handCounts[upSeat]))] = 1;

  // 12, 13, 14. self_rank, oppo_rank, cur_rank one-hot (13 dims each: 474..486, 487..499, 500..512)
  const selfLevelIdx = Math.max(1, Math.min(13, (view.teamLevels[mySeat % 2] ?? view.level) - 1));
  const oppoLevelIdx = Math.max(1, Math.min(13, (view.teamLevels[(mySeat + 1) % 2] ?? view.level) - 1));
  feature567[474 + selfLevelIdx - 1] = 1;
  feature567[487 + oppoLevelIdx - 1] = 1;
  feature567[500 + curRankIdx - 1] = 1;
}

function chooseDanZeroTribute(view: PlayerView): CardId {
  const cards = validTributeCards(view.myHand, view.level);
  // Prefer non-heart if multiple suits exist
  const nonHeart = cards.find((cid) => {
    const i = cid % 54;
    return i >= 52 || Math.floor(i / 13) !== 1;
  });
  return nonHeart ?? cards[0]!;
}

function chooseDanZeroReturn(view: PlayerView): CardId {
  const cards = validReturnCards(view.myHand, view.level, view.config);
  if (cards.length <= 1) return cards[0]!;
  const rankCounts = new Map<number, number>();
  for (const cid of view.myHand) {
    const i = cid % 54;
    const r = i === 52 ? 16 : i === 53 ? 17 : 2 + (i % 13);
    rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
  }
  let best = cards[0]!;
  let bestScore = Infinity;
  for (const cid of cards) {
    const i = cid % 54;
    const r = i === 52 ? 16 : i === 53 ? 17 : 2 + (i % 13);
    const count = rankCounts.get(r) ?? 1;
    const rankWeight = r === view.level ? 15 : r;
    const score = count * 100 + rankWeight;
    if (score < bestScore) {
      bestScore = score;
      best = cid;
    }
  }
  return best;
}

export function chooseDanZeroPlay(view: PlayerView): AIDecision {
  const candidates = buildDanZeroCandidates(view);
  if (candidates.length === 1) return candidates[0]!;

  const feature = new Int8Array(567);
  encodeDanZeroState513(view, feature);
  const baseHidden = new Float32Array(512);
  computeStateBaseHidden(feature, baseHidden);
  const scratchA = new Float32Array(512);
  const scratchB = new Float32Array(512);

  let bestIdx = 0;
  let bestQ = -Infinity;
  for (let idx = 0; idx < candidates.length; idx++) {
    const choice = candidates[idx]!;
    if (choice.type === 'pass') {
      card2arrayInto([], feature, 513);
    } else if (choice.type === 'play') {
      card2arrayInto(choice.play.cards.map(cardIdToDanZeroNum), feature, 513);
    }
    const q = evaluateDanZeroActionQ(feature, baseHidden, scratchA, scratchB);
    if (q > bestQ) {
      bestQ = q;
      bestIdx = idx;
    }
  }
  return candidates[bestIdx]!;
}

/**
 * 创建内置的 DanZero 深度蒙特卡洛（DMC）策略。
 */
export function createDanZeroPolicy(): AIPolicy {
  return {
    id: 'danzero',
    decide(view: PlayerView): AIDecision | null {
      switch (view.myDuty) {
        case 'tribute':
          return { type: 'tribute', card: chooseDanZeroTribute(view) };
        case 'return':
          return { type: 'returnTribute', card: chooseDanZeroReturn(view) };
        case 'play':
          return chooseDanZeroPlay(view);
        default:
          return null;
      }
    },
  };
}
