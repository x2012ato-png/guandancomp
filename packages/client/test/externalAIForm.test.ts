import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExternalAIForm } from '../src/ExternalAIForm.tsx';

describe('外部 AI 配置', () => {
  it('新座位可填写接口、模型及不回显的密钥，并提示发送的牌局信息', () => {
    const html = renderToStaticMarkup(createElement(ExternalAIForm, { seat: 2, initial: null, saving: false, error: '', onSubmit: () => {}, onCancel: () => {} }));
    expect(html).toContain('配置座位 3 的外部 AI');
    expect(html).toContain('API Base URL');
    expect(html).toContain('LM Studio（局内增量会话）');
    expect(html).toContain('模型名称');
    expect(html).toContain('type="password"');
    expect(html).toContain('机器人的手牌和公开牌局信息');
  });

  it('编辑时保留公开配置，并允许清除已有密钥', () => {
    const html = renderToStaticMarkup(createElement(ExternalAIForm, { seat: 1, initial: { baseUrl: 'https://model.example/v1', model: 'test-model' }, saving: false, error: '', onSubmit: () => {}, onCancel: () => {} }));
    expect(html).toContain('https://model.example/v1');
    expect(html).toContain('test-model');
    expect(html).toContain('留空保留同一地址的原密钥');
    expect(html).toContain('清除已保存的密钥');
  });

  it('重新打开 LM Studio 配置时保留接口类型和地址', () => {
    const html = renderToStaticMarkup(createElement(ExternalAIForm, { seat: 1, initial: { apiType: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', model: 'local-model' }, saving: false, error: '', onSubmit: () => {}, onCancel: () => {} }));
    expect(html).toContain('value="lmstudio" selected');
    expect(html).toContain('http://127.0.0.1:1234');
    expect(html).toContain('每个机器人每局使用独立会话');
  });
});
