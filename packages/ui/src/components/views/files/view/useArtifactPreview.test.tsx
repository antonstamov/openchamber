import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { MAX_OPEN_FILE_BYTES } from '@/lib/fileOpenLimits';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
// React DOM and the i18n store read the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18n } = await import('@/lib/i18n');
const { useArtifactPreview } = await import('./useArtifactPreview');
import type { FileNode } from './fileViewTypes';

type Args = Parameters<typeof useArtifactPreview>[0];

const file = (path: string): FileNode => ({
  name: path.split('/').pop() ?? path,
  path,
  type: 'file',
});

const args = (overrides: Partial<Omit<Args, 't'>> & { selectedPath: string; sniffed: boolean; size: number | null; readFile: Args['fileSaving']['readFile'] }): Omit<Args, 't'> => ({
  draft: { draftContent: '', setDraftContent: () => {} },
  fileAssets: {
    assetAuthErrorFallback: '',
    binaryFileActions: <span />,
    downloadButton: null,
    imageSrc: '',
    isPdfAssetAuthLoading: false,
    loadDataBytes: async () => new Uint8Array(),
    loadOfficeBytes: async () => new Uint8Array(),
    maxDataBytes: 0,
    pdfSrc: '',
    rawAsset: { src: '', loading: false, renew: async () => '' },
    saveOfficeBytes: async () => true,
  },
  fileDocument: {
    artifactSize: overrides.size,
    contentDetectedBinary: overrides.sniffed,
    fileContent: '',
    fileContentRevision: 0,
    fileError: null,
    fileLoading: false,
  },
  fileFreshness: { reloadSelectedFile: () => {} },
  fileKinds: {
    canEdit: false,
    isMermaid: false,
    isNotebook: false,
    isSelectedFont: false,
    isSelectedImage: false,
    isSelectedMedia: false,
    isSelectedPdf: false,
    isSelectedVideo: false,
    isSvgSource: false,
    isTable: false,
    isUnsupportedBinary: true,
  },
  fileSaving: { readFile: overrides.readFile },
  imageNavigation: { imageNeighbors: null },
  layout: { suppressFileLoadingIndicator: false },
  tabs: { selectedFile: file(overrides.selectedPath), selectedFileIsOutsideWorkspace: false },
  viewModes: { mermaidViewMode: 'preview', tableViewMode: 'table' },
  // SAFETY: the binary branch only reads files.uploadFile, which is absent here, so the office save stays off.
  files: {} as Args['files'],
});

let reactRoot: Root | null = null;
let container: HTMLElement | null = null;
let latest: ReturnType<typeof useArtifactPreview> | null = null;

const Probe: React.FC<{ current: Omit<Args, 't'> }> = ({ current }) => {
  const { t } = useI18n();
  const result = useArtifactPreview({ ...current, t });
  latest = result;
  return <div>{result.artifactPreview}</div>;
};

const render = async (current: Omit<Args, 't'>) => {
  if (!reactRoot) {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
  }
  await act(async () => reactRoot?.render(<I18nProvider><Probe current={current} /></I18nProvider>));
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

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  container?.remove();
  reactRoot = null;
  container = null;
  latest = null;
});

describe('useArtifactPreview binary-as-text override', () => {
  test('a sniffed-as-binary text file offers Show as text, an extension binary does not', async () => {
    await render(args({ selectedPath: '/repo/app.log', sniffed: true, size: 100, readFile: async () => '' }));
    expect(buttonWithText('Show as text')).not.toBeNull();

    await render(args({ selectedPath: '/repo/app.bin', sniffed: false, size: 100, readFile: async () => '' }));
    expect(buttonWithText('Show as text')).toBeNull();
    expect(container?.textContent).toContain('Download');
  });

  test('clicking Show as text reads the file and shows it', async () => {
    const read: Array<string> = [];
    await render(args({
      selectedPath: '/repo/app.log',
      sniffed: true,
      size: 100,
      readFile: async (path) => {
        read.push(path);
        return 'line one\nline two';
      },
    }));
    const button = buttonWithText('Show as text');
    if (!button) throw new Error('no Show as text button');
    await click(button);
    await act(async () => {});
    expect(read).toEqual(['/repo/app.log']);
    expect(container?.querySelector('pre')?.textContent).toBe('line one\nline two');
  });

  test('an oversized sniffed table is not offered the override', async () => {
    await render(args({
      selectedPath: '/repo/big.csv',
      sniffed: true,
      size: MAX_OPEN_FILE_BYTES + 1,
      readFile: async () => {
        throw new Error('must not be read');
      },
    }));
    expect(buttonWithText('Show as text')).toBeNull();
    expect(container?.textContent).toContain('too large');
  });

  test('a selection change drops the override', async () => {
    const shown = args({
      selectedPath: '/repo/app.log',
      sniffed: true,
      size: 100,
      readFile: async () => 'logged',
    });
    await render(shown);
    const button = buttonWithText('Show as text');
    if (!button) throw new Error('no Show as text button');
    await click(button);
    await act(async () => {});
    expect(container?.querySelector('pre')?.textContent).toBe('logged');

    await render(args({ selectedPath: '/repo/other.log', sniffed: true, size: 50, readFile: async () => 'other' }));
    expect(container?.querySelector('pre')).toBeNull();
    expect(buttonWithText('Show as text')).not.toBeNull();
  });

  test('a late first read resolving after a switch is discarded', async () => {
    let releaseA!: (content: string) => void;
    const pendingA = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    await render(args({ selectedPath: '/repo/a.log', sniffed: true, size: 10, readFile: () => pendingA }));
    const button = buttonWithText('Show as text');
    if (!button) throw new Error('no Show as text button');
    await click(button);

    await render(args({ selectedPath: '/repo/b.log', sniffed: true, size: 10, readFile: async () => 'bee' }));
    await act(async () => {
      releaseA('ay');
      await pendingA;
    });
    expect(container?.querySelector('pre')).toBeNull();
    expect(buttonWithText('Show as text')).not.toBeNull();
  });
});
