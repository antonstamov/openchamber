import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
// React DOM and the i18n store read the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { BinaryArtifact } = await import('./BinaryArtifact');
import type { BinaryTextPreview } from './BinaryArtifact';

let reactRoot: Root | null = null;
let container: HTMLElement | null = null;

const render = async (textPreview?: BinaryTextPreview) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(
    <I18nProvider>
      <BinaryArtifact name="app.log" path="/repo/app.log" sizeBytes={100} download={<button type="button">Download</button>} textPreview={textPreview} />
    </I18nProvider>,
  ));
};

const buttonWithText = (text: string): HTMLButtonElement | null => {
  for (const button of Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])) {
    if (button.textContent === text) return button;
  }
  return null;
};

const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.click();
  });
};

const preview = (overrides: Partial<BinaryTextPreview> = {}): BinaryTextPreview => ({
  shown: false,
  content: null,
  loading: false,
  error: null,
  onShow: () => {},
  onHide: () => {},
  ...overrides,
});

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  container?.remove();
  reactRoot = null;
  container = null;
});

describe('BinaryArtifact text override', () => {
  test('a binary by extension keeps the old screen with no override button', async () => {
    await render();
    expect(container?.textContent).toContain('does not decode LOG files');
    expect(container?.textContent).toContain('Download');
    expect(buttonWithText('Show as text')).toBeNull();
  });

  test('a sniffed-as-binary text file offers Show as text', async () => {
    let shown = 0;
    await render(preview({ onShow: () => { shown += 1; } }));
    const button = buttonWithText('Show as text');
    expect(button).not.toBeNull();
    if (!button) throw new Error('no Show as text button');
    await click(button);
    expect(shown).toBe(1);
    expect(container?.querySelector('pre')).toBeNull();
  });

  test('the override renders the text read-only with a way back', async () => {
    let hidden = 0;
    await render(preview({ shown: true, content: 'line one\nline two', onHide: () => { hidden += 1; } }));
    expect(container?.querySelector('pre')?.textContent).toBe('line one\nline two');
    expect(container?.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
    expect(container?.textContent).toContain('Download');
    const button = buttonWithText('Hide text');
    expect(button).not.toBeNull();
    if (!button) throw new Error('no Hide text button');
    await click(button);
    expect(hidden).toBe(1);
  });

  test('a failed override read offers retry', async () => {
    let shown = 0;
    await render(preview({ shown: true, error: 'boom', onShow: () => { shown += 1; } }));
    expect(container?.textContent).toContain('boom');
    expect(container?.querySelector('pre')).toBeNull();
    const button = buttonWithText('Retry');
    expect(button).not.toBeNull();
    if (!button) throw new Error('no Retry button');
    await click(button);
    expect(shown).toBe(1);
  });

  test('an override read in flight shows loading, not text', async () => {
    await render(preview({ shown: true, loading: true }));
    expect(container?.querySelector('pre')).toBeNull();
    const status = container?.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-label')).toBe('Loading');
  });
});
