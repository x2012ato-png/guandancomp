/** 令牌桶限速：每个 socket 一个桶 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  violations = 0;

  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  constructor(capacity: number, refillPerSec: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    this.violations++;
    return false;
  }
}
