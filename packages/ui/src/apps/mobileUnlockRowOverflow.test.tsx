import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { serveTestHttp } from '@/lib/test-http-server';

/**
 * The password (unlock) row on the mobile connect screen must not overflow a
 * narrow phone viewport. The regression: a single-row
 * `flex items-center justify-end gap-2` with two `whitespace-nowrap shrink-0`
 * buttons pushed the "Use another server" label off the left edge and the
 * "Unlock and connect" button past the right edge at 360 px (Russian copy is
 * the longest). The fix always stacks the actions (`flex-col-reverse`,
 * full-width buttons): the welcome column never exceeds 380 px, so a
 * viewport-based row breakpoint would still overflow on tablets.
 *
 * happy-dom performs no layout, so scrollWidth/clientWidth cannot be measured
 * here. The test pins the stacking contract that removes the overflow and
 * asserts both actions render with their full labels.
 */
test('unlock row stacks full-width actions on narrow viewports', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const server = await serveTestHttp((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/health' ? { status: 'ok' } : { authenticated: false, disabled: false }));
  });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useI18nStore } = await import('@/lib/i18n/store');
  const { MobileConnectionWelcome } = await import('./MobileConnectionWelcome');
  const { upsertMobileConnection } = await import('./mobileConnections');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const container = document.createElement('div');
  // Narrow phone viewport: the width the regression overflowed at.
  container.style.width = '360px';
  document.body.append(container);
  const root = createRoot(container);
  const clickText = async (text: string) => {
    const element = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === text);
    if (!element) throw new Error(`Missing button ${text}`);
    await act(async () => element.click());
  };
  const settle = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(done()).toBe(true);
  };
  try {
    const url = server.url.toString().replace(/\/$/, '');
    await upsertMobileConnection({ label: 'Wsl', candidates: [{ kind: 'direct', url }] });
    // Russian copy motivated the fix (the longest pair), so render it: a
    // reverted or re-lengthened translation must fail this test. Preload the
    // dictionary before mounting so its async store update lands with no
    // subscribers (no act warning) and the first render already reads Russian.
    useI18nStore.getState().setLocale('ru');
    for (let attempt = 0; attempt < 50 && useI18nStore.getState().loadingLocale === 'ru'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(useI18nStore.getState().loadingLocale).not.toBe('ru');
    await act(async () => root.render(<I18nProvider><MobileConnectionWelcome onConnected={() => {}} /></I18nProvider>));
    await clickText('Подключить');
    await settle(() => Boolean(document.querySelector('input[type="password"]')));

    const passwordForm = document.querySelector('input[type="password"]')!.closest('form')!;
    const buttons = [...passwordForm.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    const labels = buttons.map((button) => button.textContent?.trim());
    expect(labels).toContain('Разблокировать и подключить');
    expect(labels).toContain('Другой сервер');

    const row = buttons[0].parentElement!;
    expect(buttons.every((button) => button.parentElement === row)).toBe(true);
    // Always stacked: the welcome column never exceeds 380 px, so a
    // viewport-based `sm:` row would still overflow on tablets.
    expect(row.className).toContain('flex-col-reverse');
    expect(row.className).not.toContain('flex-row');
    // Full-width while stacked so neither action can push past the 360 px box.
    for (const button of buttons) {
      expect(button.className).toContain('w-full');
    }
    expect(row.className).not.toContain('truncate');
  } finally {
    await act(async () => root.unmount());
    // Restore after unmount: while mounted, a store update would re-render
    // the provider outside act().
    useI18nStore.getState().setLocale('en');
    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null });
    server.close();
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
