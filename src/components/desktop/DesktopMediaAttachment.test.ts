// @vitest-environment jsdom

import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiBearerBootstrap } from '@/components/security/ApiBearerBootstrap';
import { DesktopMediaImage } from './DesktopMediaAttachment';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let createObjectUrl: ReturnType<typeof vi.fn>;
let revokeObjectUrl: ReturnType<typeof vi.fn>;
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  createObjectUrl = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
  revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.unstubAllGlobals();
  document.querySelector('meta[name="ws-token"]')?.remove();
  Reflect.deleteProperty(window, '__o8ApiBearerInstalled');
});

describe('desktop transcript media', () => {
  it('keeps a local image pending until authenticated fetch and image load finish', async () => {
    const request = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(request.promise);
    vi.stubGlobal('fetch', fetchMock);
    act(() => root.render(createElement(DesktopMediaImage, { path: '/media/example.png', name: 'Example', maxHeight: 280 })));
    expect(host.textContent).toContain('Loading image');
    expect(host.querySelector('img')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/mobile/media?path=%2Fmedia%2Fexample.png', expect.objectContaining({ signal: expect.any(AbortSignal) }));

    request.resolve(new Response('image', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    await flush();
    const image = host.querySelector('img');
    expect(image?.getAttribute('src')).toBe('blob:first');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('blob:first');
    expect(host.textContent).toContain('Loading image');
    act(() => image?.dispatchEvent(new Event('load')));
    expect(host.textContent).not.toContain('Loading image');
    expect(image?.style.visibility).toBe('visible');
  });

  it('shows a retry after failure and revokes replaced and unmounted URLs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('first', { status: 200, headers: { 'Content-Type': 'image/png' } }))
      .mockResolvedValueOnce(new Response('second', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
    act(() => root.render(createElement(DesktopMediaImage, { path: '/media/first.png', name: 'First', maxHeight: 280 })));
    await flush();
    expect(host.textContent).toContain('Image unavailable');
    expect(host.querySelector('img')).toBeNull();

    act(() => host.querySelector('button')?.click());
    expect(host.textContent).toContain('Loading image');
    await flush();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:first');

    act(() => root.render(createElement(DesktopMediaImage, { path: '/media/second.png', name: 'Second', maxHeight: 280 })));
    expect(host.querySelector('img')).toBeNull();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first');
    await flush();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:second');
    act(() => root.unmount());
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:second');
  });

  it('ignores a stale fetch when the media path changes', async () => {
    const first = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(new Response('second', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
    act(() => root.render(createElement(DesktopMediaImage, { path: '/media/first.png', name: 'First', maxHeight: 280 })));
    act(() => root.render(createElement(DesktopMediaImage, { path: '/media/second.png', name: 'Second', maxHeight: 280 })));
    first.resolve(new Response('first', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('Second');
  });

  it('uses direct external and data URLs without a fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    act(() => root.render(createElement(Fragment, null,
      createElement(DesktopMediaImage, { path: 'https://example.com/image.png', name: 'External', maxHeight: 180 }),
      createElement(DesktopMediaImage, { path: 'data:image/png;base64,AA==', name: 'Draft', maxHeight: 180 }),
    )));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.querySelector('img[alt="External"]')?.getAttribute('src')).toBe('https://example.com/image.png');
    expect(host.querySelector('img[alt="Draft"]')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
  });

  it.each(['image/svg+xml', 'text/html'])('rejects local %s content without a navigable blob URL', async (contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<svg onload="alert(1)"></svg>', {
      status: 200,
      headers: { 'Content-Type': contentType },
    })));
    act(() => root.render(createElement(DesktopMediaImage, { path: '/media/unsafe.svg', name: 'Unsafe', maxHeight: 280 })));
    await flush();
    expect(host.textContent).toContain('Image unavailable');
    expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('uses the installed bearer bootstrap for a protected local image without forwarding the token externally', async () => {
    const meta = document.createElement('meta');
    meta.name = 'ws-token';
    meta.content = 'test-operator-token';
    document.head.appendChild(meta);
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/mobile/media?')) {
        return new Headers(init?.headers).get('Authorization') === 'Bearer test-operator-token'
          ? new Response('image', { status: 200, headers: { 'Content-Type': 'image/png' } })
          : new Response('Unauthorized', { status: 401 });
      }
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response('external', { status: 200 });
    });
    vi.stubGlobal('fetch', nativeFetch);
    const scriptMarkup = renderToStaticMarkup(createElement(ApiBearerBootstrap, { source: 'meta' }));
    const scriptHost = document.createElement('div');
    scriptHost.innerHTML = scriptMarkup;
    const script = scriptHost.querySelector('script')?.textContent;
    expect(script).toBeTruthy();
    new Function('window', 'document', 'Headers', 'Request', script ?? '')(window, document, Headers, Request);

    expect((await nativeFetch('/api/mobile/media?path=test')).status).toBe(401);
    act(() => root.render(createElement(DesktopMediaImage, { path: '/media/protected.png', name: 'Protected', maxHeight: 280 })));
    await flush();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:first');
    const protectedCall = nativeFetch.mock.calls.find(([input]) => String(input).includes('%2Fmedia%2Fprotected.png'));
    expect(protectedCall).toBeDefined();
    expect(new Headers(protectedCall?.[1]?.headers).get('Authorization')).toBe('Bearer test-operator-token');
    await window.fetch('https://example.com/image.png');
    expect(nativeFetch).toHaveBeenCalledTimes(3);
  });

  it('does not create a blob URL when an unmounted request completes', async () => {
    const request = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(request.promise));
    act(() => root.render(createElement(DesktopMediaImage, { path: '/media/pending.png', name: 'Pending', maxHeight: 280 })));
    act(() => root.unmount());
    request.resolve(new Response('image', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    await flush();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('offers retry when the browser cannot decode the fetched image', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('image', { status: 200, headers: { 'Content-Type': 'image/png' } })));
    act(() => root.render(createElement(DesktopMediaImage, { path: '/media/broken.png', name: 'Broken', maxHeight: 280 })));
    await flush();
    act(() => host.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(host.textContent).toContain('Image unavailable');
    act(() => host.querySelector('button')?.click());
    await flush();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:second');
  });
});
