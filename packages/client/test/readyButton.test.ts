import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReadyButton } from '../src/ReadyButton.tsx';

describe('ready button', () => {
  it('shows both readiness states with the same remaining time', () => {
    const props = { deadline: 16000, serverNow: 6000, onToggle: () => {} };
    const initial = renderToStaticMarkup(createElement(ReadyButton, { ...props, ready: false }));
    const ready = renderToStaticMarkup(createElement(ReadyButton, { ...props, ready: true }));
    expect(initial).toContain('aria-pressed="false"');
    expect(initial).toContain('准备');
    expect(ready).toContain('aria-pressed="true"');
    expect(ready).toContain('已准备');
    expect(initial).toContain('(10秒)');
    expect(ready).toContain('(10秒)');
  });
});
