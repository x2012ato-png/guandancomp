import { useRef, useState, type InputHTMLAttributes } from 'react';
import type { ExternalAIAPI, ExternalAISettings } from '@guandan/protocol';

const PRESET_BASE_URLS: Record<ExternalAIAPI, readonly string[]> = {
  openai: ['http://192.168.0.200:1234/v1', 'http://24.159.166.232:1234/v1'],
  lmstudio: ['http://192.168.0.200:1234/api/v1', 'http://24.159.166.232:1234/api/v1'],
};

const PRESET_MODELS = ['qwen/qwen3.5-9b'] as const;
const DEFAULT_TIMEOUT_SECONDS = 30;

function ComboInput({
  value,
  options,
  onChange,
  toggleLabel,
  ...inputProps
}: {
  value: string;
  options: readonly string[];
  onChange: (next: string) => void;
  toggleLabel: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [open, setOpen] = useState(false);
  return <div
    className="external-ai-combobox"
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
  >
    <input
      {...inputProps}
      value={value}
      onChange={event => onChange(event.target.value)}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}
    />
    <button
      type="button"
      className="external-ai-combo-toggle"
      aria-label={toggleLabel}
      aria-expanded={open}
      onClick={() => setOpen(current => !current)}
    >▾</button>
    <ul className="external-ai-combo-list" role="listbox" hidden={!open}>
      {options.map(option => <li key={option} role="option" aria-selected={value === option}>
        <button
          type="button"
          className={value === option ? 'selected' : undefined}
          onClick={() => { onChange(option); setOpen(false); }}
        >{option}</button>
      </li>)}
    </ul>
  </div>;
}

export function ExternalAIForm({ seat, initial, saving, error, onSubmit, onCancel }: {
  seat: number;
  initial: { readonly apiType?: ExternalAIAPI; readonly baseUrl: string; readonly model: string; readonly timeoutMs?: number } | null;
  saving: boolean;
  error: string;
  onSubmit: (settings: ExternalAISettings) => void;
  onCancel: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'https://api.openai.com/v1');
  const [apiType, setApiType] = useState<ExternalAIAPI>(initial?.apiType ?? 'openai');
  const [model, setModel] = useState(initial?.model ?? '');
  const [timeoutSec, setTimeoutSec] = useState(String(initial?.timeoutMs !== undefined ? Math.round(initial.timeoutMs / 1000) : DEFAULT_TIMEOUT_SECONDS));
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const backdropPressed = useRef(false);
  const presetUrls = PRESET_BASE_URLS[apiType];
  return <div
    className="external-ai-overlay"
    onMouseDown={event => { backdropPressed.current = event.target === event.currentTarget; }}
    onClick={event => {
      const shouldClose = backdropPressed.current && event.target === event.currentTarget;
      backdropPressed.current = false;
      if (shouldClose) onCancel();
    }}
  >
    <section className="external-ai-dialog" role="dialog" aria-modal="true" aria-labelledby="external-ai-title" onClick={event => event.stopPropagation()}>
      <h2 id="external-ai-title">配置座位 {seat + 1} 的外部 AI</h2>
      <p>每个机器人可使用不同配置。</p>
      <form onSubmit={event => {
        event.preventDefault();
        const parsedTimeout = Number(timeoutSec);
        const timeoutMs = Number.isFinite(parsedTimeout) ? Math.round(parsedTimeout * 1000) : DEFAULT_TIMEOUT_SECONDS * 1000;
        onSubmit({ apiType, baseUrl, model, timeoutMs, apiKey: clearKey ? null : apiKey });
      }}>
        <label>接口类型<select value={apiType} onChange={event => {
          const next = event.target.value as ExternalAIAPI;
          const prevIdx = PRESET_BASE_URLS[apiType].indexOf(baseUrl);
          if (prevIdx >= 0) setBaseUrl(PRESET_BASE_URLS[next][prevIdx]!);
          else if (next === 'lmstudio' && baseUrl === 'https://api.openai.com/v1') setBaseUrl('http://127.0.0.1:1234');
          else if (next === 'openai' && baseUrl === 'http://127.0.0.1:1234') setBaseUrl('https://api.openai.com/v1');
          setApiType(next);
        }}><option value="openai">OpenAI 兼容接口</option><option value="lmstudio">LM Studio（局内增量会话）</option></select></label>
        <label>API Base URL
          <ComboInput type="url" required value={baseUrl} options={presetUrls} onChange={setBaseUrl} toggleLabel="选择预设 API Base URL" maxLength={2048} placeholder={apiType === 'lmstudio' ? 'http://服务器可访问的地址:1234' : 'https://example.com/v1'} autoComplete="off" />
        </label>
        <label>模型名称
          <ComboInput required value={model} options={PRESET_MODELS} onChange={setModel} toggleLabel="选择预设模型名称" maxLength={200} placeholder="输入或选择模型名称" autoComplete="off" />
        </label>
        <label>超时时间（秒）<input type="number" required min={1} max={300} step={1} value={timeoutSec} onChange={event => setTimeoutSec(event.target.value)} /></label>
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
