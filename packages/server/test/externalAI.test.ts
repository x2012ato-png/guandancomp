import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpret, makeRules, reduce, toPlayerView } from '@guandan/engine';
import { decisionToAction } from '@guandan/ai';
import { cards, playingState } from '../../engine/test/helpers.ts';
import { EXTERNAL_AI_TIMEOUT_MS, LM_STUDIO_TIMEOUT_MS, parseExternalAI, runExternalAI, type ExternalAISession } from '../src/externalAI.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('外部 AI', () => {
  const config = { baseUrl: 'https://model.example/v1', model: 'test-model', apiKey: 'private-key' };
  it('校验地址和模型，修改同一地址时保留密钥，换地址或主动清除时不沿用', () => {
    expect(parseExternalAI({ baseUrl: 'https://model.example/v1/', model: ' test-model ', apiKey: 'private-key' })).toEqual(config);
    expect(parseExternalAI({ baseUrl: config.baseUrl, model: 'other', apiKey: '' }, config)?.apiKey).toBe('private-key');
    expect(parseExternalAI({ baseUrl: config.baseUrl, model: 'other', apiKey: null }, config)?.apiKey).toBe('');
    expect(parseExternalAI({ baseUrl: 'https://another.example/v1', model: 'other', apiKey: '' }, config)?.apiKey).toBe('');
    for (const baseUrl of ['file:///etc/passwd', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret', 'invalid']) {
      expect(parseExternalAI({ baseUrl, model: 'model' })).toBeNull();
    }
    expect(parseExternalAI({ baseUrl: config.baseUrl, model: '', apiKey: '' })).toBeNull();
    expect(parseExternalAI({ baseUrl: config.baseUrl, model: 'x', apiKey: 'a\nb' })).toBeNull();
    expect(parseExternalAI({ baseUrl: 'http://localhost:1234', model: 'local', apiType: 'lmstudio' })).toEqual({ baseUrl: 'http://localhost:1234', model: 'local', apiKey: '', apiType: 'lmstudio' });
    expect(parseExternalAI({ baseUrl: config.baseUrl, model: 'x', apiType: 'invalid' })).toBeNull();
  });

  it('发送仅属于机器人视角的信息，让模型选择合法动作', async () => {
    const state = playingState([cards('S3 D3 S4 D5'), cards('BJ S8'), cards('SJ S6'), cards('S7 D7')]);
    const view = toPlayerView(state, 0);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"choice":0}\n```' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const decision = await new Promise<Parameters<typeof decisionToAction>[1] | null>(resolve => runExternalAI(config, view, resolve));
    expect(decision).not.toBeNull();
    expect(reduce(state, decisionToAction(0, decision!)).ok).toBe(true);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://model.example/v1/chat/completions');
    expect(options.redirect).toBe('error');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer private-key' });
    const body = JSON.parse(options.body as string);
    const request = JSON.parse(body.messages[1].content);
    expect(body.model).toBe('test-model');
    expect(request.view).toEqual(view);
    expect(request.view).not.toHaveProperty('hands');
    expect(request.view.myHand).toEqual(state.hands[0]);
    expect(request.choices[0].index).toBe(0);
    expect(JSON.stringify(body)).not.toContain(config.apiKey);
  });

  it('LM Studio 同局使用独立会话发送增量，新局或历史不连续时重新发送快照', async () => {
    const lmConfig = { ...config, apiType: 'lmstudio' as const, baseUrl: 'http://localhost:1234' };
    let state = playingState([cards('S3 D3 C4 S9'), cards('S5 D5'), cards('S6 D6'), cards('S7 D7')]);
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ response_id: `resp_${requests.length}`, output: [{ type: 'reasoning', content: 'ignored' }, { type: 'message', content: '{"choice":0}' }] }));
    }));
    const ask = (view: ReturnType<typeof toPlayerView>, session?: ExternalAISession) => new Promise<{ decision: Parameters<typeof decisionToAction>[1] | null; session?: ExternalAISession }>(resolve => {
      runExternalAI(lmConfig, view, (decision, next) => resolve({ decision, session: next }), session);
    });
    const first = await ask(toPlayerView(state, 0));
    expect(requests[0]!.url).toBe('http://localhost:1234/api/v1/chat');
    expect(requests[0]!.body).not.toHaveProperty('previous_response_id');
    expect(JSON.parse(requests[0]!.body.input).mode).toBe('snapshot');
    expect(first.session?.responseId).toBe('resp_1');
    const played = reduce(state, decisionToAction(0, first.decision!));
    if (!played.ok) throw new Error(played.error.message);
    state = played.state;
    for (const seat of [1, 2, 3] as const) {
      const pass = reduce(state, { type: 'pass', seat });
      if (!pass.ok) throw new Error(pass.error.message);
      state = pass.state;
    }
    const current = toPlayerView(state, 0);
    const second = await ask(current, first.session);
    expect(requests[1]!.body.previous_response_id).toBe('resp_1');
    expect(requests[1]!.body).not.toHaveProperty('system_prompt');
    const delta = JSON.parse(requests[1]!.body.input);
    expect(delta.mode).toBe('incremental');
    expect(delta).not.toHaveProperty('view');
    expect(delta.publicHistoryAppend).toEqual(current.publicHistory);
    expect(delta.playedCardsAppend).toEqual(current.playedCards);
    expect(delta.changes.myHand).toEqual(current.myHand);
    expect(delta.changes.handCounts).toEqual(current.handCounts);
    expect(delta.choices.length).toBeGreaterThan(0);
    expect(second.session?.responseId).toBe('resp_2');

    await ask({ ...current, handNo: current.handNo + 1, publicHistory: [], playedCards: [] }, second.session);
    expect(requests[2]!.body).not.toHaveProperty('previous_response_id');
    expect(JSON.parse(requests[2]!.body.input).mode).toBe('snapshot');
    await ask({ ...current, publicHistory: [] }, second.session);
    expect(requests[3]!.body).not.toHaveProperty('previous_response_id');
    expect(JSON.parse(requests[3]!.body.input).mode).toBe('snapshot');
    await ask({ ...current, seat: 2 }, second.session);
    expect(requests[4]!.body).not.toHaveProperty('previous_response_id');
  });

  it('LM Studio 缺少会话标识或返回非法选择时不保存会话', async () => {
    const lmConfig = { ...config, apiType: 'lmstudio' as const };
    const view = toPlayerView(playingState([cards('S3 D3'), cards('S5'), cards('S6'), cards('S7')]), 0);
    for (const response of [
      { output: [{ type: 'message', content: '{"choice":0}' }] },
      { response_id: 'resp_1', output: [{ type: 'message', content: '{"choice":999}' }] },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
      const result = await new Promise<{ decision: unknown; session: unknown }>(resolve => runExternalAI(lmConfig, view, (decision, session) => resolve({ decision, session })));
      expect(result).toEqual({ decision: null, session: undefined });
    }
  });

  it('跟牌时允许选择不要；无法压住单张时不会伪造出牌', async () => {
    const last = interpret(cards('BJ'), 2, makeRules())[0]!;
    const state = playingState([cards('S3 D4'), cards('S8 D8'), cards('S6 D6'), cards('S7 D7')], {
      trick: { leader: 3, lastPlay: { seat: 3, play: last }, passed: [], history: [{ seat: 3, play: last }] },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"choice":0}' } }] }))));
    const decision = await new Promise(resolve => runExternalAI(config, toPlayerView(state, 0), resolve));
    expect(decision).toEqual({ type: 'pass' });
  });

  it.each(['{"choice":999}', '{"choice":"0"}', 'not-json'])('拒绝模型的无效选择 %s', async content => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))));
    const view = toPlayerView(playingState([cards('S3 D3'), cards('S5'), cards('S6'), cards('S7')]), 0);
    expect(await new Promise(resolve => runExternalAI(config, view, resolve))).toBeNull();
  });

  it('接口超时回退，取消请求则不再执行回调', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const view = toPlayerView(playingState([cards('S3 D3'), cards('S5'), cards('S6'), cards('S7')]), 0);
    const done = vi.fn();
    runExternalAI(config, view, done);
    await vi.advanceTimersByTimeAsync(EXTERNAL_AI_TIMEOUT_MS);
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(null);
    const cancelled = vi.fn();
    const cancel = runExternalAI(config, view, cancelled);
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    await vi.advanceTimersByTimeAsync(EXTERNAL_AI_TIMEOUT_MS);
    expect(cancelled).not.toHaveBeenCalled();
    const native = vi.fn();
    runExternalAI({ ...config, apiType: 'lmstudio' }, view, native);
    await vi.advanceTimersByTimeAsync(EXTERNAL_AI_TIMEOUT_MS);
    expect(native).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LM_STUDIO_TIMEOUT_MS - EXTERNAL_AI_TIMEOUT_MS);
    expect(native).toHaveBeenCalledWith(null);
  });
});
