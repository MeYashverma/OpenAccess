/**
 * OpenAccess page runtime.
 *
 * This file is injected as the first script into every proxied HTML document.
 * It adapts the page to the proxy environment:
 *
 *  - routes fetch/XHR/WebSocket/EventSource/beacon through the proxy,
 *  - mirrors real URL/title/favicon state to the browser shell,
 *  - forwards link clicks that would leave the frame (target=_blank, modifiers),
 *  - maps history and Location method calls back into proxy space,
 *  - provides namespaced localStorage/sessionStorage and document.cookie,
 *  - forwards keyboard shortcuts and navigation commands.
 *
 * It is deliberately defensive: every patch is wrapped so an unsupported
 * browser fails one feature, not the whole page.
 */

import type { ParentToRuntimeMessage, RuntimeBootstrap, RuntimeToParentMessage } from '../shared/runtime.js';
import {
  endpointBase,
  realLocation,
  toProxyUrl,
  toProxyWebSocketUrl,
  toRealUrl,
  type ProxyContext,
} from './url-map.js';

(() => {
  const INSTALL_FLAG = '__openaccessRuntimeInstalled';
  const globalWindow = window as unknown as Record<string, unknown>;
  if (globalWindow[INSTALL_FLAG]) return;
  globalWindow[INSTALL_FLAG] = true;

  const configElement = document.getElementById('__oa-bootstrap');
  if (!configElement || !configElement.textContent) return;

  let config: RuntimeBootstrap;
  try {
    config = JSON.parse(configElement.textContent) as RuntimeBootstrap;
  } catch {
    return;
  }
  if (!config.token || !config.target || !config.contentOrigin) return;

  try {
    configElement.remove();
  } catch {
    /* ignore */
  }

  const target = new URL(config.target);
  const ctx: ProxyContext = {
    token: config.token,
    contentOrigin: config.contentOrigin.replace(/\/$/, ''),
    targetOrigin: target.origin,
  };
  const hostname = target.hostname;
  const endpoints = endpointBase(ctx);
  const isolated = config.mode === 'isolated';

  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const NativeWebSocket = window.WebSocket;
  const NativeEventSource = window.EventSource;

  // -------------------------------------------------------------------
  // Messaging with the browser shell
  // -------------------------------------------------------------------

  let parentTargetOrigin = config.parentOrigin || '*';
  try {
    new URL(parentTargetOrigin);
  } catch {
    parentTargetOrigin = '*';
  }

  function post(message: RuntimeToParentMessage): void {
    if (!window.parent || window.parent === window) return;
    try {
      window.parent.postMessage(message, parentTargetOrigin);
    } catch {
      try {
        window.parent.postMessage(message, '*');
      } catch {
        /* ignore */
      }
    }
  }

  let lastReportedUrl = '';
  let lastReportedTitle = '';

  function currentRealUrl(): string {
    return realLocation(location.href, ctx);
  }

  function reportNavigated(force = false): void {
    const url = currentRealUrl();
    const title = document.title || '';
    if (!force && url === lastReportedUrl && title === lastReportedTitle) return;
    lastReportedUrl = url;
    lastReportedTitle = title;
    post({ __oa: true, type: 'navigate', url, title });
  }

  function reportTitle(): void {
    if (document.title === lastReportedTitle) return;
    lastReportedTitle = document.title;
    post({ __oa: true, type: 'title', title: document.title });
  }

  function reportIcon(): void {
    try {
      const link = document.querySelector<HTMLLinkElement>(
        'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
      );
      post({ __oa: true, type: 'icon', href: link ? link.href : null });
    } catch {
      /* ignore */
    }
  }

  function reportLoading(loading: boolean): void {
    post({ __oa: true, type: 'loading', loading });
  }

  // -------------------------------------------------------------------
  // URL helpers bound to this document
  // -------------------------------------------------------------------

  function proxyUrl(raw: string): string {
    try {
      return toProxyUrl(raw, document.baseURI, ctx);
    } catch {
      return raw;
    }
  }

  function realUrl(raw: string): string | null {
    try {
      return toRealUrl(raw, document.baseURI, ctx);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------
  // fetch / XHR / beacon / EventSource / WebSocket
  // -------------------------------------------------------------------

  if (nativeFetch) {
    const patchedFetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          return nativeFetch!(proxyUrl(String(input)), init);
        }
        if (input instanceof Request) {
          const mapped = proxyUrl(input.url);
          if (mapped !== input.url) {
            try {
              return nativeFetch!(new Request(mapped, input), init);
            } catch {
              return nativeFetch!(input, init);
            }
          }
          return nativeFetch!(input, init);
        }
      } catch {
        /* fall through */
      }
      return nativeFetch!(input as RequestInfo, init);
    };
    window.fetch = patchedFetch as typeof window.fetch;
  }

  try {
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      const mapped = proxyUrl(String(url));
      (nativeXhrOpen as unknown as (...args: unknown[]) => void).call(this, method, mapped, ...rest);
    } as typeof XMLHttpRequest.prototype.open;
  } catch {
    /* ignore */
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseURL');
    if (descriptor?.get) {
      Object.defineProperty(XMLHttpRequest.prototype, 'responseURL', {
        configurable: true,
        get(this: XMLHttpRequest) {
          const raw = descriptor.get!.call(this) as string;
          return realUrl(raw) ?? raw;
        },
      });
    }
  } catch {
    /* ignore */
  }

  if (navigator.sendBeacon) {
    try {
      const nativeBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean =>
        nativeBeacon(proxyUrl(String(url)), data);
    } catch {
      /* ignore */
    }
  }

  if (NativeWebSocket) {
    try {
      function OpenAccessWebSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
        return new NativeWebSocket(toProxyWebSocketUrl(String(url), document.baseURI, ctx), protocols);
      }
      OpenAccessWebSocket.prototype = NativeWebSocket.prototype;
      for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
        Object.defineProperty(OpenAccessWebSocket, key, {
          value: (NativeWebSocket as unknown as Record<string, number>)[key],
          enumerable: true,
        });
      }
      (window as unknown as Record<string, unknown>).WebSocket = OpenAccessWebSocket;
    } catch {
      /* ignore */
    }
  }

  if (NativeEventSource) {
    try {
      function OpenAccessEventSource(this: unknown, url: string | URL, init?: EventSourceInit) {
        return new NativeEventSource(proxyUrl(String(url)), init);
      }
      OpenAccessEventSource.prototype = NativeEventSource.prototype;
      for (const key of ['CONNECTING', 'OPEN', 'CLOSED'] as const) {
        Object.defineProperty(OpenAccessEventSource, key, {
          value: (NativeEventSource as unknown as Record<string, number>)[key],
          enumerable: true,
        });
      }
      (window as unknown as Record<string, unknown>).EventSource = OpenAccessEventSource;
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------
  // DOM URL attributes set from JavaScript
  // -------------------------------------------------------------------

  const URL_ATTRIBUTES = new Set([
    'href',
    'src',
    'action',
    'formaction',
    'data',
    'poster',
    'background',
    'cite',
    'longdesc',
    'xlink:href',
  ]);

  function rewriteSrcset(value: string): string {
    return value
      .split(',')
      .map((candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed) return trimmed;
        const space = trimmed.search(/\s/);
        const url = space === -1 ? trimmed : trimmed.slice(0, space);
        const descriptor = space === -1 ? '' : trimmed.slice(space);
        if (/^(data|blob):/i.test(url)) return trimmed;
        return `${proxyUrl(url)}${descriptor}`;
      })
      .join(', ');
  }

  try {
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (
      this: Element,
      name: string,
      value: string,
    ): void {
      try {
        const lower = String(name).toLowerCase();
        if (typeof value === 'string') {
          if (lower === 'srcset' || lower === 'imagesrcset') {
            value = rewriteSrcset(value);
          } else if (URL_ATTRIBUTES.has(lower)) {
            value = proxyUrl(value);
          }
        }
      } catch {
        /* use original value */
      }
      return nativeSetAttribute.call(this, name, value);
    };
  } catch {
    /* ignore */
  }

  function patchUrlProperty(
    constructor: { prototype?: object } | undefined,
    property: string,
    transform: (value: string) => string,
  ): void {
    try {
      const proto = constructor?.prototype;
      if (!proto) return;
      const descriptor = Object.getOwnPropertyDescriptor(proto, property);
      if (!descriptor?.get || !descriptor.set || descriptor.configurable === false) return;
      Object.defineProperty(proto, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get(this: unknown) {
          return descriptor.get!.call(this);
        },
        set(this: unknown, value: unknown) {
          let next = value;
          try {
            next = transform(String(value));
          } catch {
            /* keep original */
          }
          descriptor.set!.call(this, next);
        },
      });
    } catch {
      /* ignore */
    }
  }

  patchUrlProperty(HTMLImageElement, 'src', proxyUrl);
  patchUrlProperty(HTMLImageElement, 'srcset', rewriteSrcset);
  patchUrlProperty(HTMLScriptElement, 'src', proxyUrl);
  patchUrlProperty(HTMLLinkElement, 'href', proxyUrl);
  patchUrlProperty(HTMLIFrameElement, 'src', proxyUrl);
  patchUrlProperty(HTMLSourceElement, 'src', proxyUrl);
  patchUrlProperty(HTMLSourceElement, 'srcset', rewriteSrcset);
  patchUrlProperty(HTMLMediaElement, 'src', proxyUrl);
  patchUrlProperty(HTMLVideoElement, 'poster', proxyUrl);
  patchUrlProperty(HTMLFormElement, 'action', proxyUrl);
  patchUrlProperty(HTMLObjectElement, 'data', proxyUrl);
  patchUrlProperty(HTMLEmbedElement, 'src', proxyUrl);
  patchUrlProperty(HTMLTrackElement, 'src', proxyUrl);
  patchUrlProperty(HTMLInputElement, 'src', proxyUrl);
  patchUrlProperty(HTMLInputElement, 'formAction', proxyUrl);
  patchUrlProperty(HTMLButtonElement, 'formAction', proxyUrl);
  patchUrlProperty(HTMLAnchorElement, 'href', proxyUrl);
  patchUrlProperty(HTMLAreaElement, 'href', proxyUrl);

  // -------------------------------------------------------------------
  // History API: keep the frame's address inside proxy space
  // -------------------------------------------------------------------

  for (const method of ['pushState', 'replaceState'] as const) {
    try {
      const original = history[method].bind(history);
      history[method] = function (state: unknown, title: string, url?: string | URL | null) {
        if (url === undefined || url === null) return original(state, title, url as undefined);
        let mapped = url;
        try {
          // History URLs resolve against the current document URL, which may
          // already include an earlier pushState path.
          mapped = toProxyUrl(String(url), location.href, ctx);
        } catch {
          /* keep original */
        }
        const result = original(state, title, mapped);
        window.setTimeout(() => reportNavigated(), 0);
        return result;
      } as History['pushState'];
    } catch {
      /* ignore */
    }
  }

  for (const method of ['assign', 'replace'] as const) {
    try {
      const original = Location.prototype[method];
      if (!original) continue;
      Object.defineProperty(Location.prototype, method, {
        configurable: true,
        writable: true,
        value: function (url: string | URL) {
          // A relative or absolute URL can be mapped; javascript:/mailto: is
          // intentionally passed through untouched.
          return original.call(this, proxyUrl(String(url)));
        },
      });
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('popstate', () => reportNavigated());
  window.addEventListener('hashchange', () => reportNavigated());
  window.addEventListener('beforeunload', () => reportLoading(true));

  // -------------------------------------------------------------------
  // Click + form handling
  // -------------------------------------------------------------------

  function postOpenTab(rawUrl: string, options: { background?: boolean; replace?: boolean }): void {
    const resolved = realUrl(rawUrl) ?? rawUrl;
    if (!resolved || !/^https?:/i.test(resolved)) return;
    post({ __oa: true, type: 'open-tab', url: resolved, ...options });
  }

  document.addEventListener(
    'click',
    (event) => {
      const element = event.target as Element | null;
      const anchor = element?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) return;

      const targetName = anchor.getAttribute('target') ?? '';
      const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;

      if (targetName === '_blank' || modified) {
        event.preventDefault();
        event.stopPropagation();
        postOpenTab(anchor.href, { background: modified && !event.shiftKey });
        return;
      }
      if (targetName === '_top' || targetName === '_parent') {
        event.preventDefault();
        event.stopPropagation();
        postOpenTab(anchor.href, { replace: true });
      }
    },
    true,
  );

  document.addEventListener(
    'auxclick',
    (event) => {
      if (event.button !== 1) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      event.preventDefault();
      postOpenTab(anchor.href, { background: true });
    },
    true,
  );

  function normaliseFormTargets(root: ParentNode): void {
    for (const form of root.querySelectorAll('form[target]')) {
      const targetName = form.getAttribute('target');
      if (targetName && targetName !== '_self') form.setAttribute('target', '_self');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => normaliseFormTargets(document), { once: true });
  } else {
    normaliseFormTargets(document);
  }

  // -------------------------------------------------------------------
  // window.open
  // -------------------------------------------------------------------

  try {
    window.open = function (url?: string | URL, _target?: string, _features?: string): Window | null {
      if (url) postOpenTab(String(url), { background: true });
      const stub = {
        closed: false,
        focus() {},
        blur() {},
        close() {
          stub.closed = true;
        },
        postMessage() {},
        location: { href: url ? String(url) : 'about:blank', assign() {}, replace() {}, reload() {} },
        document: { write() {}, close() {} },
      };
      return stub as unknown as Window;
    };
  } catch {
    /* ignore */
  }

  // -------------------------------------------------------------------
  // document.cookie
  // -------------------------------------------------------------------

  let cookieState = config.cookie || '';

  function mergeCookie(current: string, addition: string): string {
    const pair = addition.split(';', 1)[0] ?? '';
    const equals = pair.indexOf('=');
    if (equals <= 0) return current;
    const name = pair.slice(0, equals).trim();
    const maxAge = /(?:^|;)\s*max-age\s*=\s*(-?\d+)/i.exec(addition)?.[1];
    const parts = current
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => part.slice(0, part.indexOf('=')).trim() !== name);
    if (maxAge !== undefined && Number(maxAge) <= 0) return parts.join('; ');
    parts.push(pair.trim());
    return parts.join('; ');
  }

  function sendCookie(cookie: string): void {
    if (!nativeFetch) return;
    try {
      void nativeFetch(`${endpoints}/cookie`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: config.handle, cookie }),
        credentials: 'omit',
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() {
        return cookieState;
      },
      set(value: string) {
        if (typeof value !== 'string') return;
        cookieState = mergeCookie(cookieState, value);
        sendCookie(value);
      },
    });
  } catch {
    /* browsers that do not allow redefining document.cookie keep the snapshot */
  }

  // -------------------------------------------------------------------
  // Web Storage
  // -------------------------------------------------------------------

  interface StorageBackend {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
    clear(): void;
    keys(): string[];
  }

  class MemoryBackend implements StorageBackend {
    private data = new Map<string, string>();
    get(key: string): string | null {
      return this.data.get(key) ?? null;
    }
    set(key: string, value: string): void {
      this.data.set(key, value);
    }
    remove(key: string): void {
      this.data.delete(key);
    }
    clear(): void {
      this.data.clear();
    }
    keys(): string[] {
      return [...this.data.keys()];
    }
  }

  function createFacade(backend: StorageBackend): Storage {
    const target: Record<string, unknown> = {
      getItem(key: string) {
        return backend.get(String(key));
      },
      setItem(key: string, value: string) {
        backend.set(String(key), String(value));
      },
      removeItem(key: string) {
        backend.remove(String(key));
      },
      clear() {
        backend.clear();
      },
      key(index: number) {
        return backend.keys()[index] ?? null;
      },
    };
    Object.defineProperty(target, 'length', {
      enumerable: true,
      get: () => backend.keys().length,
    });
    return new Proxy(target, {
      get(object, property) {
        if (property in object) return Reflect.get(object, property);
        if (typeof property === 'string') {
          const value = backend.get(property);
          return value === null ? undefined : value;
        }
        return undefined;
      },
      set(object, property, value) {
        if (typeof property === 'string' && !(property in object)) {
          backend.set(property, String(value));
          return true;
        }
        return Reflect.set(object, property, value);
      },
      has(object, property) {
        if (property in object) return true;
        return typeof property === 'string' && backend.get(property) !== null;
      },
      deleteProperty(object, property) {
        if (typeof property === 'string') backend.remove(property);
        return true;
      },
      ownKeys(object) {
        return [...backend.keys(), ...Reflect.ownKeys(object)];
      },
      getOwnPropertyDescriptor(object, property) {
        if (typeof property === 'string' && backend.get(property) !== null) {
          return { configurable: true, enumerable: true, value: backend.get(property) };
        }
        return Reflect.getOwnPropertyDescriptor(object, property);
      },
    }) as unknown as Storage;
  }

  function nativeBackend(storage: Storage, prefix: string): StorageBackend {
    return {
      get(key) {
        try {
          return storage.getItem(prefix + key);
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          storage.setItem(prefix + key, value);
        } catch {
          throw new DOMException('The storage quota has been exceeded.', 'QuotaExceededError');
        }
      },
      remove(key) {
        try {
          storage.removeItem(prefix + key);
        } catch {
          /* ignore */
        }
      },
      clear() {
        try {
          const doomed: string[] = [];
          for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (key && key.startsWith(prefix)) doomed.push(key);
          }
          for (const key of doomed) storage.removeItem(key);
        } catch {
          /* ignore */
        }
      },
      keys() {
        const keys: string[] = [];
        try {
          for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (key && key.startsWith(prefix)) keys.push(key.slice(prefix.length));
          }
        } catch {
          /* ignore */
        }
        return keys;
      },
    };
  }

  function serverBackend(): StorageBackend {
    const items = new Map<string, string>();
    let loaded = false;
    const storageUrl = `${endpoints}/storage`;

    try {
      const request = new XMLHttpRequest();
      request.open('GET', `${storageUrl}?handle=${encodeURIComponent(config.handle)}`, false);
      request.send(null);
      if (request.status === 200) {
        const payload = JSON.parse(request.responseText) as { items?: Record<string, string> };
        for (const [key, value] of Object.entries(payload.items ?? {})) items.set(key, value);
        loaded = true;
      }
    } catch {
      /* offline fallback: memory only */
    }

    const persist = (body: Record<string, unknown>): void => {
      if (!nativeFetch) return;
      try {
        void nativeFetch(storageUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ handle: config.handle, ...body }),
          credentials: 'omit',
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* ignore */
      }
    };

    return {
      get(key) {
        return items.get(key) ?? null;
      },
      set(key, value) {
        if (value.length > 100_000) {
          throw new DOMException('The storage quota has been exceeded.', 'QuotaExceededError');
        }
        items.set(key, value);
        persist({ op: 'set', key, value });
      },
      remove(key) {
        items.delete(key);
        persist({ op: 'remove', key });
      },
      clear() {
        items.clear();
        persist({ op: 'clear' });
      },
      keys() {
        return [...items.keys()];
      },
    };
  }

  const facadeCache = new Map<string, Storage>();
  const backendByNativeStorage = new WeakMap<object, StorageBackend>();
  const nativeStorageMethods = {
    getItem: Storage.prototype.getItem,
    setItem: Storage.prototype.setItem,
    removeItem: Storage.prototype.removeItem,
    clear: Storage.prototype.clear,
    key: Storage.prototype.key,
  };
  let storagePrototypePatched = false;

  /**
   * Some browsers expose localStorage/sessionStorage as non-configurable
   * accessors. In that case fall back to patching Storage.prototype and keying
   * each native storage object to its namespaced backend.
   */
  function patchStoragePrototype(): void {
    if (storagePrototypePatched) return;
    storagePrototypePatched = true;
    try {
      Storage.prototype.getItem = function (key: string) {
        const backend = backendByNativeStorage.get(this as unknown as object);
        return backend ? backend.get(String(key)) : nativeStorageMethods.getItem.call(this, key);
      };
      Storage.prototype.setItem = function (key: string, value: string) {
        const backend = backendByNativeStorage.get(this as unknown as object);
        if (backend) backend.set(String(key), String(value));
        else nativeStorageMethods.setItem.call(this, key, value);
      };
      Storage.prototype.removeItem = function (key: string) {
        const backend = backendByNativeStorage.get(this as unknown as object);
        if (backend) backend.remove(String(key));
        else nativeStorageMethods.removeItem.call(this, key);
      };
      Storage.prototype.clear = function () {
        const backend = backendByNativeStorage.get(this as unknown as object);
        if (backend) backend.clear();
        else nativeStorageMethods.clear.call(this);
      };
      Storage.prototype.key = function (index: number) {
        const backend = backendByNativeStorage.get(this as unknown as object);
        if (backend) return backend.keys()[index] ?? null;
        return nativeStorageMethods.key.call(this, index);
      };
      Object.defineProperty(Storage.prototype, 'length', {
        configurable: true,
        get(this: Storage) {
          const backend = backendByNativeStorage.get(this as unknown as object);
          return backend ? backend.keys().length : 0;
        },
      });
    } catch {
      /* ignore */
    }
  }

  function installStorage(kind: 'localStorage' | 'sessionStorage', backend: StorageBackend): void {
    let facade = facadeCache.get(kind);
    if (!facade) {
      facade = createFacade(backend);
      facadeCache.set(kind, facade);
    }
    try {
      Object.defineProperty(window, kind, {
        configurable: true,
        get: () => facade!,
      });
      return;
    } catch {
      /* fall through to prototype patching */
    }
    try {
      const native = window[kind];
      if (native) {
        patchStoragePrototype();
        backendByNativeStorage.set(native, backend);
      }
    } catch {
      /* ignore */
    }
  }

  if (isolated) {
    // Separate content origin: the iframe has a real (same-origin) storage
    // area, but it is shared by every proxied site. Namespace every key.
    let localNative: Storage | null = null;
    let sessionNative: Storage | null = null;
    try {
      localNative = window.localStorage;
    } catch {
      localNative = null;
    }
    try {
      sessionNative = window.sessionStorage;
    } catch {
      sessionNative = null;
    }
    installStorage(
      'localStorage',
      localNative ? nativeBackend(localNative, `oa:${hostname}:`) : config.storage ? serverBackend() : new MemoryBackend(),
    );
    installStorage(
      'sessionStorage',
      sessionNative ? nativeBackend(sessionNative, `oa:${hostname}:`) : new MemoryBackend(),
    );
  } else {
    // Opaque-origin sandbox: native storage is unavailable. Persist the
    // localStorage equivalent on the server so logins survive navigation.
    const sharedLocal = config.storage ? serverBackend() : new MemoryBackend();
    installStorage('localStorage', sharedLocal);
    installStorage('sessionStorage', new MemoryBackend());
  }

  // Namespace IndexedDB per destination site when it is available natively.
  if (isolated) {
    try {
      const nativeIdb = window.indexedDB;
      if (nativeIdb) {
        const prefix = `oa:${hostname}:`;
        const facade = Object.create(nativeIdb) as IDBFactory;
        Object.defineProperties(facade, {
          open: {
            value: (name: string, version?: number) => nativeIdb.open(prefix + name, version),
          },
          deleteDatabase: {
            value: (name: string) => nativeIdb.deleteDatabase(prefix + name),
          },
          databases: {
            value: async () => {
              const list = await nativeIdb.databases?.();
              return (list ?? [])
                .filter((entry) => entry.name?.startsWith(prefix))
                .map((entry) => ({ ...entry, name: entry.name?.slice(prefix.length) }));
            },
          },
        });
        Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => facade });
      }
    } catch {
      /* ignore */
    }
  } else {
    try {
      Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });
    } catch {
      /* ignore */
    }
  }

  // Service workers cannot operate in a proxied third-party frame; expose a
  // predictable rejection instead of a confusing SecurityError.
  try {
    const sw = navigator.serviceWorker;
    if (sw && typeof sw.register === 'function') {
      sw.register = () =>
        Promise.reject(new Error('Service workers are not available inside the OpenAccess proxy.'));
    }
  } catch {
    /* ignore */
  }

  // -------------------------------------------------------------------
  // Link hover status
  // -------------------------------------------------------------------

  let lastHoverUrl: string | null = null;
  document.addEventListener(
    'mouseover',
    (event) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const resolved = realUrl(anchor.href);
      if (resolved !== lastHoverUrl) {
        lastHoverUrl = resolved;
        post({ __oa: true, type: 'link', url: resolved });
      }
    },
    true,
  );
  document.addEventListener(
    'mouseout',
    (event) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!anchor) return;
      if (lastHoverUrl !== null) {
        lastHoverUrl = null;
        post({ __oa: true, type: 'link', url: null });
      }
    },
    true,
  );

  // -------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------

  document.addEventListener(
    'keydown',
    (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      let action: string | null = null;
      if (modifier && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'l') action = 'focus-address';
        else if (key === 't' && event.shiftKey) action = 'reopen-tab';
        else if (key === 't') action = 'new-tab';
        else if (key === 'w') action = 'close-tab';
        else if (key === 'r') action = 'reload';
        else if (key === 'd') action = 'bookmark';
      } else if (event.altKey && event.key === 'ArrowLeft') {
        action = 'back';
      } else if (event.altKey && event.key === 'ArrowRight') {
        action = 'forward';
      }
      if (action) {
        event.preventDefault();
        post({ __oa: true, type: 'shortcut', action });
      }
    },
    true,
  );

  // -------------------------------------------------------------------
  // Commands from the browser shell
  // -------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (config.parentOrigin && config.parentOrigin !== 'null' && event.origin !== config.parentOrigin) {
      return;
    }
    const data = event.data as ParentToRuntimeMessage | null;
    if (!data || data.__oaCommand !== true) return;
    try {
      switch (data.command) {
        case 'back':
          history.back();
          break;
        case 'forward':
          history.forward();
          break;
        case 'reload':
          location.reload();
          break;
        case 'stop':
          window.stop();
          break;
        case 'focus':
          window.focus();
          break;
        case 'navigate':
          if (typeof data.url === 'string' && /^https?:/i.test(data.url)) {
            location.href = proxyUrl(data.url);
          }
          break;
      }
    } catch {
      /* ignore */
    }
  });

  // -------------------------------------------------------------------
  // Title, favicon and URL observation
  // -------------------------------------------------------------------

  function observeHead(): void {
    const head = document.head;
    if (!head) return;
    const observer = new MutationObserver(() => {
      reportTitle();
      reportIcon();
    });
    try {
      observer.observe(head, { subtree: true, childList: true, characterData: true });
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('load', () => {
    reportNavigated(true);
    reportIcon();
    reportLoading(false);
    observeHead();
  });

  document.addEventListener('DOMContentLoaded', () => {
    reportNavigated(true);
    reportIcon();
    observeHead();
    post({ __oa: true, type: 'ready', url: currentRealUrl(), title: document.title });
  });

  window.setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    reportNavigated();
  }, 800);

  let errorBudget = 3;
  window.addEventListener('error', (event) => {
    if (errorBudget <= 0) return;
    errorBudget--;
    const message = event.message ? String(event.message).slice(0, 300) : 'Script error';
    post({ __oa: true, type: 'error', message });
  });

  // Exposed deliberately (namespaced) so the browser shell can show diagnostics
  // and so power users can see which session they are on.
  globalWindow.__openaccess = {
    version: 1,
    session: config.token.slice(0, 6),
    target: config.target,
    realUrl: currentRealUrl,
    isProxied: () => location.pathname.startsWith(`/p/${config.token}/`),
    mode: config.mode,
  };
})();
