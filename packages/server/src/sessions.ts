import { randomBytes, randomUUID } from 'node:crypto';

export interface Session {
  readonly playerId: string;
  readonly token: string;
  nickname: string;
  roomId: string | null;
  readonly sockets: Set<string>;
  lastSeen: number;
}

/** 会话：token 是断线重连凭证（存于客户端 localStorage），playerId 对其他玩家公开 */
export class SessionStore {
  private byToken = new Map<string, Session>();
  private byId = new Map<string, Session>();

  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  create(nickname: string): Session {
    const s: Session = {
      playerId: randomUUID(),
      token: randomBytes(24).toString('base64url'),
      nickname,
      roomId: null,
      sockets: new Set(),
      lastSeen: this.now(),
    };
    this.byToken.set(s.token, s);
    this.byId.set(s.playerId, s);
    return s;
  }

  byTokenOrNull(token: unknown): Session | null {
    return typeof token === 'string' ? (this.byToken.get(token) ?? null) : null;
  }

  get(playerId: string): Session | null {
    return this.byId.get(playerId) ?? null;
  }

  isOnline(playerId: string): boolean {
    return (this.byId.get(playerId)?.sockets.size ?? 0) > 0;
  }

  /** 清理长期离线且不在房间中的会话 */
  sweep(maxIdleMs: number): void {
    const t = this.now();
    for (const s of this.byId.values()) {
      if (s.sockets.size === 0 && !s.roomId && t - s.lastSeen > maxIdleMs) {
        this.byId.delete(s.playerId);
        this.byToken.delete(s.token);
      }
    }
  }
}
