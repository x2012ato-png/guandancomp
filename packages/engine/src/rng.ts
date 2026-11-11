/**
 * 可序列化的确定性伪随机数（mulberry32）。
 * RNG 状态保存在 GameState 中，使 reducer 保持纯函数；该状态属于隐藏信息，绝不能进入 PlayerView。
 */

export type RngState = number;

export function seedRng(seed: number | string): RngState {
  if (typeof seed === 'number') return seed >>> 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 返回 [0,1) 浮点数与下一个状态 */
export function nextRandom(state: RngState): [number, RngState] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, next];
}

export function nextInt(state: RngState, maxExclusive: number): [number, RngState] {
  const [v, s] = nextRandom(state);
  return [Math.floor(v * maxExclusive), s];
}

/** Fisher–Yates，返回新数组与新状态 */
export function shuffle<T>(items: readonly T[], state: RngState): [T[], RngState] {
  const arr = [...items];
  let s = state;
  for (let i = arr.length - 1; i > 0; i--) {
    let j: number;
    [j, s] = nextInt(s, i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return [arr, s];
}

/** 可变闭包形式，仅供 AI / 测试等非状态代码使用 */
export function makeRandom(seed: number | string): () => number {
  let s = seedRng(seed);
  return () => {
    const [v, n] = nextRandom(s);
    s = n;
    return v;
  };
}
