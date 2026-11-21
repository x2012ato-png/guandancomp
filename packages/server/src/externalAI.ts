import { cardLabel, comboLabel, generatePlays, partnerOf, rankLabel, validReturnCards, validTributeCards, type PlayerView } from '@guandan/engine';
import type { AIDecision } from '@guandan/ai';
import type { ExternalAIAPI, ExternalAISettings } from '@guandan/protocol';

export interface ExternalAIConfig { readonly apiType?: ExternalAIAPI; readonly baseUrl: string; readonly model: string; readonly apiKey: string }
export interface ExternalAISession { readonly responseId: string; readonly view: PlayerView }
export const EXTERNAL_AI_TIMEOUT_MS = 15_000;
export const LM_STUDIO_TIMEOUT_MS = 60_000;

/** 空密钥在修改同一地址时保留旧值；null 明确清除。 */
export function parseExternalAI(value: unknown, previous?: ExternalAIConfig): ExternalAIConfig | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<ExternalAISettings>;
  if (typeof input.baseUrl !== 'string' || typeof input.model !== 'string' ||
      (input.apiType !== undefined && input.apiType !== 'openai' && input.apiType !== 'lmstudio') ||
      (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string')) return null;
  const model = input.model.trim(), suppliedKey = input.apiKey?.trim() ?? '';
  if (!model || model.length > 200 || !input.baseUrl.trim() || input.baseUrl.length > 2048 || suppliedKey.length > 2048 || /[\r\n]/.test(suppliedKey)) return null;
  try {
    const url = new URL(input.baseUrl.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const baseUrl = url.toString().replace(/\/+$/, '');
    const key = input.apiKey === null ? '' : suppliedKey || (previous?.baseUrl === baseUrl ? previous.apiKey : '');
    return { baseUrl, model, apiKey: key, ...(input.apiType === 'lmstudio' ? { apiType: 'lmstudio' } : {}) };
  } catch { return null; }
}

function legalChoices(view: PlayerView): AIDecision[] {
  if (view.myDuty === 'tribute') return validTributeCards(view.myHand, view.level).map(card => ({ type: 'tribute', card }));
  if (view.myDuty === 'return') return validReturnCards(view.myHand, view.level, view.config).map(card => ({ type: 'returnTribute', card }));
  if (view.myDuty !== 'play') return [];
  const choices: AIDecision[] = generatePlays(view.myHand, view.level, view.config, view.trick?.lastPlay?.play.combo)
    .map(play => ({ type: 'play', play }));
  if (view.trick?.lastPlay) choices.push({ type: 'pass' });
  return choices;
}

function choiceDescription(decision: AIDecision, index: number) {
  if (decision.type === 'pass') return { index, action: '不要' };
  if (decision.type === 'tribute' || decision.type === 'returnTribute') return { index, action: decision.type === 'tribute' ? '进贡' : '还贡', card: cardLabel(decision.card) };
  return { index, action: '出牌', combo: comboLabel(decision.play.combo), comboData: decision.play.combo, cards: decision.play.cards.map(cardLabel), cardIds: decision.play.cards, wildAssignments: decision.play.wildAssignments };
}

function visibleCardIds(view: PlayerView): Set<number> {
  return new Set([...view.myHand, ...view.playedCards, ...(view.tribute?.paid.map(item => item.card) ?? []),
    ...(view.tribute?.links.flatMap(link => link.returnCard === null ? [link.card] : [link.card, link.returnCard]) ?? [])]);
}

function isPrefix(previous: readonly unknown[], current: readonly unknown[]): boolean {
  return previous.length <= current.length && previous.every((item, index) => JSON.stringify(item) === JSON.stringify(current[index]));
}

/** 仅沿用同一座位、同一局且公开历史连续的会话，否则重新发送快照。 */
function canContinue(session: ExternalAISession | undefined, view: PlayerView): session is ExternalAISession {
  const previous = session?.view;
  return !!previous && previous.seat === view.seat && previous.handNo === view.handNo &&
    !!previous.publicHistory && !!view.publicHistory && isPrefix(previous.publicHistory, view.publicHistory) &&
    isPrefix(previous.playedCards, view.playedCards);
}

function sessionInput(view: PlayerView, session: ExternalAISession | undefined, choices: readonly AIDecision[]) {
  const continuation = canContinue(session, view);
  const previous = continuation ? session.view : undefined;
  const previousCards = previous ? visibleCardIds(previous) : new Set<number>();
  const cardLabels = Object.fromEntries([...visibleCardIds(view)].filter(card => !previousCards.has(card)).map(card => [card, cardLabel(card)]));
  const described = choices.map(choiceDescription);
  if (!previous) return { mode: 'snapshot', view, levelLabel: rankLabel(view.level), partnerSeat: partnerOf(view.seat), cardLabels, choices: described };
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(view) as (keyof PlayerView)[]) {
    if (key === 'publicHistory' || key === 'playedCards') continue;
    if (JSON.stringify(previous[key]) !== JSON.stringify(view[key])) changes[key] = view[key];
  }
  return { mode: 'incremental', changes, publicHistoryAppend: view.publicHistory!.slice(previous.publicHistory!.length),
    playedCardsAppend: view.playedCards.slice(previous.playedCards.length), cardLabels, choices: described };
}

const SYSTEM_PROMPT = '你是掼蛋选手，与对家一队。只能从提供的合法选项中选择一项；综合牌权、队友、牌型和剩余张数。只回复 JSON，例如 {"choice":0}，不要输出其他内容。view 是本座位可见的信息，cardLabels 将可见牌 ID 转换为牌面；其余手牌不可见。mode 为 incremental 时，用 changes 中的字段替换之前的 view 对应字段，将 publicHistoryAppend 和 playedCardsAppend 分别追加到之前的公开历史和已出牌中，cardLabels 补充可见牌映射；choices 每次都是当前合法选项，不能沿用上次编号。牌面、级牌、历史与候选以服务器数据为准。';

/** 仅发送该座位的玩家视图；由规则引擎列出合法候选，模型只选择编号。 */
export function runExternalAI(config: ExternalAIConfig, view: PlayerView, done: (decision: AIDecision | null, session?: ExternalAISession) => void, session?: ExternalAISession): () => void {
  const controller = new AbortController();
  let finished = false;
  const timer = setTimeout(() => controller.abort(), config.apiType === 'lmstudio' ? LM_STUDIO_TIMEOUT_MS : EXTERNAL_AI_TIMEOUT_MS);
  const finish = (decision: AIDecision | null, nextSession?: ExternalAISession) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (nextSession) done(decision, nextSession); else done(decision);
  };
  void Promise.resolve().then(async () => {
    try {
      const choices = legalChoices(view);
      if (!choices.length) { finish(null); return; }
      const stateful = config.apiType === 'lmstudio';
      const previous = stateful && canContinue(session, view) ? session : undefined;
      const input = sessionInput(view, previous, choices);
      const url = stateful ? config.baseUrl.endsWith('/api/v1/chat') ? config.baseUrl : config.baseUrl.endsWith('/api/v1') ? `${config.baseUrl}/chat` : `${config.baseUrl}/api/v1/chat`
        : config.baseUrl.endsWith('/chat/completions') ? config.baseUrl : `${config.baseUrl}/chat/completions`;
      const body = stateful
        ? { model: config.model, stream: false, store: true, ...(previous ? { previous_response_id: previous.responseId } : { system_prompt: SYSTEM_PROMPT }), input: JSON.stringify(input) }
        : { model: config.model, stream: false, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(input) }] };
      const response = await fetch(url, {
        method: 'POST', signal: controller.signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok) { finish(null); return; }
      const result: unknown = await response.json();
      const native = result as { response_id?: unknown; output?: { type?: unknown; content?: unknown }[] };
      const content = stateful ? native?.output?.filter(item => item.type === 'message').at(-1)?.content
        : (result as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length > 10_000) { finish(null); return; }
      if (stateful && (typeof native.response_id !== 'string' || !native.response_id.startsWith('resp_'))) { finish(null); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { finish(null); return; }
      const index = typeof parsed === 'number' ? parsed : (parsed as { choice?: unknown } | null)?.choice;
      const decision = typeof index === 'number' && Number.isInteger(index) ? choices[index] ?? null : null;
      finish(decision, stateful && decision ? { responseId: native.response_id as string, view } : undefined);
    } catch { finish(null); }
  });
  return () => { if (!finished) { finished = true; clearTimeout(timer); controller.abort(); } };
}
