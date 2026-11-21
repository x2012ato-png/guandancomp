import { useState } from 'react';
import type { ExternalAIAPI, ExternalAISettings } from '@guandan/protocol';

export function ExternalAIForm({ seat, initial, saving, error, onSubmit, onCancel }: {
  seat: number;
  initial: { readonly apiType?: ExternalAIAPI; readonly baseUrl: string; readonly model: string } | null;
  saving: boolean;
  error: string;
  onSubmit: (settings: ExternalAISettings) => void;
  onCancel: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'https://api.openai.com/v1');
  const [apiType, setApiType] = useState<ExternalAIAPI>(initial?.apiType ?? 'openai');
  const [model, setModel] = useState(initial?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  return <div className="external-ai-overlay" onClick={onCancel}>
    <section className="external-ai-dialog" role="dialog" aria-modal="true" aria-labelledby="external-ai-title" onClick={event => event.stopPropagation()}>
      <h2 id="external-ai-title">配置座位 {seat + 1} 的外部 AI</h2>
      <p>每个机器人可使用不同配置。</p>
      <form onSubmit={event => { event.preventDefault(); onSubmit({ apiType, baseUrl, model, apiKey: clearKey ? null : apiKey }); }}>
        <label>接口类型<select value={apiType} onChange={event => {
          const next = event.target.value as ExternalAIAPI;
          if (next === 'lmstudio' && baseUrl === 'https://api.openai.com/v1') setBaseUrl('http://127.0.0.1:1234');
          if (next === 'openai' && baseUrl === 'http://127.0.0.1:1234') setBaseUrl('https://api.openai.com/v1');
          setApiType(next);
        }}><option value="openai">OpenAI 兼容接口</option><option value="lmstudio">LM Studio（局内增量会话）</option></select></label>
        <label>API Base URL<input type="url" required value={baseUrl} maxLength={2048} onChange={event => setBaseUrl(event.target.value)} placeholder={apiType === 'lmstudio' ? 'http://服务器可访问的地址:1234' : 'https://example.com/v1'} autoComplete="off" /></label>
        <label>模型名称<input required value={model} maxLength={200} onChange={event => setModel(event.target.value)} placeholder="输入服务商提供的模型名称" autoComplete="off" /></label>
        <label>API 密钥<input type="password" value={apiKey} maxLength={2048} onChange={event => setApiKey(event.target.value)} placeholder={initial ? '留空保留同一地址的原密钥' : '无需认证时可留空'} autoComplete="new-password" disabled={clearKey} /></label>
        {initial && <label className="external-ai-clear"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />清除已保存的密钥</label>}
        <p>服务器会发送该机器人的手牌和公开牌局信息；服务商可能收取调用费用。密钥仅保存在服务器内存中。</p>
        {apiType === 'lmstudio' && <p>每个机器人每局使用独立会话；127.0.0.1 指游戏服务器所在机器。</p>}
        <p>外部服务请使用 HTTPS；HTTP 适用于受信任的本地服务。</p>
        {error && <p className="external-ai-error" role="alert">{error}</p>}
        <div className="external-ai-actions"><button type="button" onClick={onCancel} disabled={saving}>取消</button><button className="primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button></div>
      </form>
    </section>
  </div>;
}
