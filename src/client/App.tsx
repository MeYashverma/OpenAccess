import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeToParentMessage } from '../shared/runtime';
import {
  addressBarToUrl,
  displayUrl,
  hostLabel,
  parseAbsoluteUrl,
  proxifyUrl,
  searchUrl,
  SEARCH_ENGINES,
} from '../shared/url';
import { createSession, destroySession, fetchConfig, validateSession } from './api';
import { Menu } from './components/Menu';
import { NewTabPage } from './components/NewTabPage';
import { PanelRouter } from './components/Panels';
import { TabStrip } from './components/TabStrip';
import { Toolbar, type Suggestion } from './components/Toolbar';
import { usePersistentState } from './storage';
import {
  DEFAULT_SETTINGS,
  type Bookmark,
  type ClientConfig,
  type HistoryEntry,
  type Panel,
  type SessionInfo,
  type Settings,
  type TabState,
} from './types';
import { CloseIcon, GlobeIcon, ReloadIcon, ShieldIcon, TabsIcon } from './icons';

const MAX_TABS = 12;
const TAB_STORAGE_KEY = 'oa.tabs';
let idCounter = 0;
const makeId = (): string => `t${Date.now().toString(36)}${(idCounter++).toString(36)}`;

interface StoredTab {
  url: string;
  title: string;
}

function makeNewTab(): TabState {
  return {
    id: makeId(),
    url: null,
    src: null,
    title: 'New tab',
    icon: null,
    loading: false,
    hasRuntime: false,
    error: null,
    createdAt: Date.now(),
    seq: 0,
  };
}

function makeWebTab(url: URL, token: string, config: ClientConfig): TabState {
  return {
    id: makeId(),
    url: url.href,
    src: proxifyUrl(token, url, config.contentOrigin),
    title: hostLabel(url),
    icon: null,
    loading: true,
    hasRuntime: false,
    error: null,
    createdAt: Date.now(),
    seq: 0,
  };
}

function readStoredTabs(): StoredTab[] {
  try {
    const raw = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredTab[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.url === 'string' && parseAbsoluteUrl(entry.url))
      .slice(0, MAX_TABS);
  } catch {
    return [];
  }
}

export default function App() {
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeId, setActiveId] = useState('');

  const [settings, setSettings] = usePersistentState<Settings>('oa.settings', DEFAULT_SETTINGS);
  const [bookmarks, setBookmarks] = usePersistentState<Bookmark[]>('oa.bookmarks', []);
  const [history, setHistory] = usePersistentState<HistoryEntry[]>('oa.history', []);

  const [address, setAddress] = useState('');
  const [addressFocused, setAddressFocused] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoverUrl, setHoverUrl] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showIntro, setShowIntro] = useState(() => {
    try {
      return localStorage.getItem('oa.introDismissed') !== '1';
    } catch {
      return true;
    }
  });
  const [mobileTabs, setMobileTabs] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    action: () => void;
  } | null>(null);

  const frameRefs = useRef(new Map<string, HTMLIFrameElement | null>());
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | null>(null);
  const actionsRef = useRef<Record<string, (...args: never[]) => void>>({});
  const historyRef = useRef(history);
  const settingsRef = useRef(settings);
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const addressFocusedRef = useRef(addressFocused);

  historyRef.current = history;
  settingsRef.current = settings;
  tabsRef.current = tabs;
  activeIdRef.current = activeId;
  addressFocusedRef.current = addressFocused;

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null;
  const currentUrl = activeTab?.url ?? null;
  const isBookmarked = Boolean(currentUrl && bookmarks.some((bookmark) => bookmark.url === currentUrl));

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // ---------------------------------------------------------------------
  // Boot: config + a valid browsing session
  // ---------------------------------------------------------------------

  const boot = useCallback(async (fresh: boolean) => {
    setBooting(true);
    setBootError(null);
    try {
      const cfg = await fetchConfig();
      setConfig(cfg);

      let info: SessionInfo | null = null;
      if (!fresh) {
        try {
          const stored = localStorage.getItem('oa.session');
          if (stored) info = await validateSession(stored);
        } catch {
          /* fall through to a new session */
        }
      }
      if (!info) info = await createSession();
      localStorage.setItem('oa.session', info.token);
      setSession(info);
      setExpired(false);

      const stored = fresh ? [] : readStoredTabs();
      const initial = stored.length
        ? stored.map((entry) => makeWebTab(new URL(entry.url), info!.token, cfg))
        : [makeNewTab()];
      setTabs(initial);
      setActiveId(initial[0]!.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reach the OpenAccess server.';
      setBootError(message);
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    void boot(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the visible address bar in sync with the active tab.
  useEffect(() => {
    if (addressFocused) return;
    setAddress(activeTab?.url ? displayUrl(activeTab.url) : '');
  }, [activeTab?.id, activeTab?.url, addressFocused]);

  useEffect(() => {
    document.title = activeTab?.title && activeTab.url ? `${activeTab.title} — OpenAccess` : 'OpenAccess';
  }, [activeTab?.title, activeTab?.url]);

  // Persist open tabs for this browser tab only.
  useEffect(() => {
    if (!session) return;
    const stored: StoredTab[] = tabs
      .filter((tab) => tab.url)
      .map((tab) => ({ url: tab.url!, title: tab.title }));
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      /* ignore */
    }
  }, [tabs, session]);

  // Theme handling.
  useEffect(() => {
    const apply = (): void => {
      const resolved =
        settings.theme === 'system'
          ? window.matchMedia?.('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
          : settings.theme;
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    media?.addEventListener?.('change', apply);
    return () => media?.removeEventListener?.('change', apply);
  }, [settings.theme]);

  // Session watchdog.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const info = await validateSession(session.token);
        if (!cancelled && !info) setExpired(true);
      } catch {
        /* network hiccup: don't expire the UI */
      }
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session]);

  // Fullscreen state.
  useEffect(() => {
    const onChange = (): void => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ---------------------------------------------------------------------
  // Tab actions
  // ---------------------------------------------------------------------

  const updateTab = useCallback((id: string, patch: Partial<TabState>) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  }, []);

  const navigateTab = useCallback(
    (id: string, input: URL | string) => {
      if (!session || !config) return;
      const url = typeof input === 'string' ? addressBarToUrl(input, settings.searchEngine) : input;
      if (!url) {
        showToast('That address could not be understood');
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        showToast('Only http and https addresses can be opened');
        return;
      }
      const src = proxifyUrl(session.token, url, config.contentOrigin);
      setTabs((current) =>
        current.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                url: url.href,
                src,
                title: tab.url ? tab.title : hostLabel(url),
                icon: null,
                loading: true,
                hasRuntime: false,
                error: null,
                seq: tab.seq + 1,
              }
            : tab,
        ),
      );
      setAddress(displayUrl(url));
      setAddressFocused(false);
      inputRef.current?.blur();
    },
    [session, config, settings.searchEngine, showToast],
  );

  const openTab = useCallback(
    (rawUrl?: string, options?: { background?: boolean; replace?: boolean }) => {
      if (!session || !config) return;

      if (options?.replace && activeId) {
        if (rawUrl) navigateTab(activeId, rawUrl);
        return;
      }

      const url = rawUrl ? addressBarToUrl(rawUrl, settings.searchEngine) : null;
      if (rawUrl && !url) return;
      if (tabsRef.current.length >= MAX_TABS) {
        showToast(`Maximum of ${MAX_TABS} tabs reached`);
        return;
      }
      const tab = url ? makeWebTab(url, session.token, config) : makeNewTab();
      setTabs((current) => (current.length >= MAX_TABS ? current : [...current, tab]));
      if (!options?.background) {
        setActiveId(tab.id);
        setAddress(url ? displayUrl(url) : '');
        setAddressFocused(false);
      }
    },
    [session, config, settings.searchEngine, activeId, navigateTab, showToast],
  );

  const closeTab = useCallback(
    (id: string) => {
      setTabs((current) => {
        if (current.length === 0) return current;
        const index = current.findIndex((tab) => tab.id === id);
        const next = current.filter((tab) => tab.id !== id);
        if (next.length === 0) {
          const fresh = makeNewTab();
          setActiveId(fresh.id);
          return [fresh];
        }
        if (id === activeId) {
          const fallback = next[Math.max(0, index - 1)] ?? next[0]!;
          setActiveId(fallback.id);
        }
        return next;
      });
      frameRefs.current.delete(id);
      setMobileTabs(false);
    },
    [activeId],
  );

  const selectTab = useCallback((id: string) => {
    setActiveId(id);
    setMenuOpen(false);
    setMobileTabs(false);
    setAddressFocused(false);
  }, []);

  const goHome = useCallback(() => {
    if (!activeId) return;
    if (settings.homeMode === 'url' && settings.homeUrl.trim()) {
      navigateTab(activeId, settings.homeUrl.trim());
      return;
    }
    setTabs((current) =>
      current.map((tab) => (tab.id === activeId ? { ...tab, url: null, src: null, title: 'New tab', icon: null, loading: false, seq: tab.seq + 1 } : tab)),
    );
    setAddress('');
  }, [activeId, settings.homeMode, settings.homeUrl, navigateTab]);

  const sendCommand = useCallback(
    (command: 'back' | 'forward' | 'reload' | 'stop' | 'focus') => {
      if (!activeTab || !config) return;
      const frame = frameRefs.current.get(activeTab.id);
      try {
        frame?.contentWindow?.postMessage({ __oaCommand: true, command }, '*');
      } catch {
        /* ignore */
      }
      if (command === 'reload' && !activeTab.hasRuntime && activeTab.url) {
        updateTab(activeTab.id, { seq: activeTab.seq + 1, loading: true });
      }
      if (command === 'reload') updateTab(activeTab.id, { loading: true });
      if (command === 'stop') updateTab(activeTab.id, { loading: false });
    },
    [activeTab, config, updateTab],
  );

  // ---------------------------------------------------------------------
  // Bookmarks, history, copy, data clearing
  // ---------------------------------------------------------------------

  const toggleBookmark = useCallback(() => {
    if (!currentUrl) return;
    const title = activeTab?.title || hostLabel(currentUrl);
    setBookmarks((current) => {
      const existing = current.find((bookmark) => bookmark.url === currentUrl);
      if (existing) {
        showToast('Bookmark removed');
        return current.filter((bookmark) => bookmark.id !== existing.id);
      }
      showToast('Bookmark added');
      return [{ id: makeId(), url: currentUrl, title, createdAt: Date.now() }, ...current].slice(0, 500);
    });
  }, [currentUrl, activeTab?.title, setBookmarks, showToast]);

  const recordVisit = useCallback(
    (url: string, title: string) => {
      if (!settingsRef.current.saveHistory) return;
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) return;
      } catch {
        return;
      }
      setHistory((current) => {
        if (current[0]?.url === url) return current;
        return [
          { id: makeId(), url, title: title || hostLabel(url), visitedAt: Date.now() },
          ...current.filter((entry) => entry.url !== url),
        ].slice(0, 200);
      });
    },
    [setHistory],
  );

  const copyAddress = useCallback(
    async (value?: string | null) => {
      const target = value ?? currentUrl;
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target);
        showToast('Address copied');
      } catch {
        try {
          const area = document.createElement('textarea');
          area.value = target;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
          showToast('Address copied');
        } catch {
          showToast('Could not copy the address');
        }
      }
    },
    [currentUrl, showToast],
  );

  const startNewSession = useCallback(async () => {
    setConfirm(null);
    try {
      const previous = session?.token ?? null;
      const info = await createSession();
      if (previous && previous !== info.token) {
        // Drop the old cookie jar and site storage as soon as the replacement
        // session exists; the UI copy promises a clean session.
        void destroySession(previous).catch(() => undefined);
      }
      localStorage.setItem('oa.session', info.token);
      setSession(info);
      setExpired(false);
      setTabs((current) =>
        current.map((tab) =>
          tab.url
            ? {
                ...tab,
                src: proxifyUrl(info.token, new URL(tab.url), info.contentOrigin),
                loading: true,
                hasRuntime: false,
                seq: tab.seq + 1,
              }
            : tab,
        ),
      );
      showToast('Started a fresh browsing session');
    } catch {
      showToast('Could not start a new session right now');
    }
  }, [showToast, session]);

  const clearData = useCallback(() => {
    setConfirm({
      title: 'Clear browsing data?',
      message:
        'This ends the proxied session on the server, clearing proxied cookies and site storage, and removes bookmarks and history stored in this browser.',
      confirmLabel: 'Clear data',
      action: () => {
        void (async () => {
          if (session) await destroySession(session.token);
          try {
            localStorage.removeItem('oa.session');
            localStorage.removeItem('oa.bookmarks');
            localStorage.removeItem('oa.history');
            sessionStorage.removeItem(TAB_STORAGE_KEY);
          } catch {
            /* ignore */
          }
          setBookmarks([]);
          setHistory([]);
          setPanel(null);
          setConfirm(null);
          await boot(true);
          showToast('Browsing data cleared');
        })();
      },
    });
  }, [session, setBookmarks, setHistory, boot, showToast]);

  const toggleFullscreen = useCallback(() => {
    void (async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        showToast('Full screen is not available');
      }
    })();
  }, [showToast]);

  // ---------------------------------------------------------------------
  // Messages from proxied pages
  // ---------------------------------------------------------------------

  const actions = useMemo(
    () => ({
      openTab,
      closeTab,
      navigateTab,
      sendCommand,
      toggleBookmark,
      setPanel,
      setAddressFocused,
    }),
    [openTab, closeTab, navigateTab, sendCommand, toggleBookmark],
  );
  useEffect(() => {
    actionsRef.current = actions as unknown as Record<string, (...args: never[]) => void>;
  }, [actions]);

  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      if (event.origin !== 'null' && config && event.origin !== new URL(config.contentOrigin).origin) {
        return;
      }
      const data = event.data as RuntimeToParentMessage | null;
      if (!data || data.__oa !== true) return;

      let tabId: string | null = null;
      for (const [id, frame] of frameRefs.current) {
        if (frame?.contentWindow === event.source) {
          tabId = id;
          break;
        }
      }
      if (!tabId) return;

      switch (data.type) {
        case 'ready':
          updateTab(tabId, { loading: false, hasRuntime: true, url: data.url, title: data.title || hostLabel(data.url) });
          recordVisit(data.url, data.title);
          if (tabId === activeIdRef.current && !addressFocusedRef.current) {
            setAddress(displayUrl(data.url));
          }
          break;
        case 'navigate':
          setTabs((current) =>
            current.map((tab) =>
              tab.id === tabId
                ? { ...tab, url: data.url, title: data.title || tab.title, loading: false, hasRuntime: true }
                : tab,
            ),
          );
          recordVisit(data.url, data.title);
          if (tabId === activeIdRef.current && !addressFocusedRef.current) {
            setAddress(displayUrl(data.url));
          }
          break;
        case 'title':
          updateTab(tabId, { title: data.title });
          break;
        case 'icon':
          updateTab(tabId, { icon: data.href });
          break;
        case 'loading':
          updateTab(tabId, { loading: data.loading });
          break;
        case 'error':
          updateTab(tabId, { error: data.message });
          break;
        case 'open-tab':
          if (data.replace) actionsRef.current.navigateTab?.(tabId as never, data.url as never);
          else actionsRef.current.openTab?.(data.url as never, { background: data.background } as never);
          break;
        case 'shortcut':
          if (data.action === 'focus-address') {
            inputRef.current?.focus();
            inputRef.current?.select();
          } else if (data.action === 'new-tab') actionsRef.current.openTab?.();
          else if (data.action === 'close-tab') actionsRef.current.closeTab?.(tabId as never);
          else if (data.action === 'reload') actionsRef.current.sendCommand?.('reload' as never);
          else if (data.action === 'back') actionsRef.current.sendCommand?.('back' as never);
          else if (data.action === 'forward') actionsRef.current.sendCommand?.('forward' as never);
          else if (data.action === 'bookmark') actionsRef.current.toggleBookmark?.();
          else if (data.action === 'reopen-tab') actionsRef.current.openTab?.();
          break;
        case 'link':
          setHoverUrl(data.url);
          break;
        default:
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [config, updateTab, recordVisit]);

  // Frame load handler.
  const handleFrameLoad = useCallback(
    (id: string) => {
      updateTab(id, { loading: false });
    },
    [updateTab],
  );

  // ---------------------------------------------------------------------
  // Address bar + suggestions
  // ---------------------------------------------------------------------

  const suggestions: Suggestion[] = useMemo(() => {
    const query = address.trim().toLowerCase();
    if (!addressFocused || !query) return [];
    const historyEntries = history.map((entry) => ({
      kind: 'history' as const,
      title: entry.title,
      url: entry.url,
    }));
    const bookmarkEntries = bookmarks.map((entry) => ({
      kind: 'bookmark' as const,
      title: entry.title,
      url: entry.url,
    }));
    const seen = new Set<string>();
    const matches = [...bookmarkEntries, ...historyEntries]
      .filter((entry) => {
        if (!entry.url.toLowerCase().includes(query) && !entry.title.toLowerCase().includes(query)) return false;
        if (seen.has(entry.url)) return false;
        seen.add(entry.url);
        return true;
      })
      .slice(0, 5);

    const engine = SEARCH_ENGINES.find((entry) => entry.id === settings.searchEngine) ?? SEARCH_ENGINES[0]!;
    const searchCandidate: Suggestion = {
      kind: 'search',
      title: `Search ${engine.name} for “${address.trim()}”`,
      url: searchUrl(engine.id, address.trim()),
    };
    return [...matches, searchCandidate];
  }, [address, addressFocused, bookmarks, history, settings.searchEngine]);

  const submitAddress = useCallback(() => {
    const value = address.trim();
    if (!value) return;
    const target = addressBarToUrl(value, settings.searchEngine);
    if (!target) {
      showToast('That address could not be understood');
      return;
    }
    navigateTab(activeId, target);
  }, [address, settings.searchEngine, navigateTab, activeId, showToast]);

  const selectSuggestion = useCallback(
    (suggestion: Suggestion) => {
      if (suggestion.kind === 'search') {
        navigateTab(activeId, suggestion.url);
        return;
      }
      navigateTab(activeId, suggestion.url);
    },
    [navigateTab, activeId],
  );

  // ---------------------------------------------------------------------
  // Global keyboard shortcuts (UI context)
  // ---------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (modifier && event.key.toLowerCase() === 't') {
        event.preventDefault();
        openTab();
      } else if (modifier && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        closeTab(activeId);
      } else if (modifier && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        sendCommand('reload');
      } else if (modifier && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        toggleBookmark();
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        sendCommand('back');
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        sendCommand('forward');
      } else if (event.key === 'Escape') {
        setMenuOpen(false);
        setPanel(null);
        setMobileTabs(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openTab, closeTab, activeId, sendCommand, toggleBookmark]);

  // Close the menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  const dismissIntro = useCallback(() => {
    setShowIntro(false);
    try {
      localStorage.setItem('oa.introDismissed', '1');
    } catch {
      /* ignore */
    }
  }, []);

  const openInActiveTab = useCallback(
    (url: string) => {
      navigateTab(activeId, url);
      setPanel(null);
    },
    [navigateTab, activeId],
  );

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  if (booting) {
    return (
      <div className="boot-screen">
        <div className="boot-mark">
          <GlobeIcon size={28} />
        </div>
        <div className="boot-title">OpenAccess</div>
        <div className="boot-sub">Starting a private browsing session…</div>
        <div className="boot-bar" role="progressbar" aria-label="Loading" />
      </div>
    );
  }

  if (bootError || !config || !session) {
    return (
      <div className="boot-screen">
        <div className="boot-mark boot-mark-muted">
          <GlobeIcon size={28} />
        </div>
        <div className="boot-title">OpenAccess could not start</div>
        <div className="boot-sub">{bootError ?? 'The server is not responding.'}</div>
        <button type="button" className="button primary" onClick={() => void boot(false)}>
          Try again
        </button>
        <p className="boot-hint">
          If you are the operator, check the server logs and make sure the deployment environment variables are set.
        </p>
      </div>
    );
  }

  const sandbox = [
    'allow-scripts',
    'allow-forms',
    'allow-popups',
    'allow-modals',
    'allow-downloads',
    'allow-pointer-lock',
    // User-activated top navigation lets links that intentionally replace the
    // page and the proxy's own error-page link work. Programmatic top
    // navigation without a gesture stays blocked by the sandbox.
    'allow-top-navigation-by-user-activation',
    ...(config.mode === 'isolated' ? ['allow-same-origin'] : []),
  ].join(' ');

  return (
    <div className={`shell${isFullscreen ? ' shell-fullscreen' : ''}`}>
      <header className="chrome">
        <div className="chrome-top">
          <TabStrip
            tabs={tabs}
            activeId={activeId}
            onSelect={selectTab}
            onClose={closeTab}
            onNew={() => openTab()}
            compact
          />
          <button
            type="button"
            className="icon-button mobile-tabs-button"
            aria-label="Show tabs"
            onClick={() => setMobileTabs(true)}
          >
            <TabsIcon size={18} />
            <span className="mobile-tab-count">{tabs.length}</span>
          </button>
        </div>

        <Toolbar
          address={address}
          addressFocused={addressFocused}
          loading={Boolean(activeTab?.loading)}
          currentUrl={currentUrl}
          bookmarked={isBookmarked}
          suggestions={suggestions}
          suggestionsOpen={addressFocused && suggestions.length > 0}
          onFocusAddress={() => {
            setAddressFocused(true);
            setMenuOpen(false);
          }}
          onBlurAddress={() => setAddressFocused(false)}
          onChangeAddress={setAddress}
          onSubmit={submitAddress}
          onSelectSuggestion={selectSuggestion}
          onBack={() => sendCommand('back')}
          onForward={() => sendCommand('forward')}
          onReload={() => sendCommand('reload')}
          onStop={() => sendCommand('stop')}
          onHome={goHome}
          onToggleBookmark={toggleBookmark}
          onCopy={() => void copyAddress()}
          onOpenMenu={() => setMenuOpen((open) => !open)}
          inputRef={inputRef}
        />

        {activeTab?.loading ? <div className="loading-bar" role="progressbar" aria-label="Loading page" /> : null}
      </header>

      <main className="content">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-view${tab.id === activeId ? ' is-active' : ''}`}
            hidden={tab.id !== activeId}
          >
            {tab.url === null ? (
              <NewTabPage
                config={config}
                settings={settings}
                bookmarks={bookmarks}
                history={history}
                showIntro={showIntro}
                onDismissIntro={dismissIntro}
                onSearch={(url) => navigateTab(tab.id, url)}
                onOpenUrl={(url) => navigateTab(tab.id, url)}
                onOpenPanel={(next) => {
              setPanel(next);
              setMenuOpen(false);
            }}
              />
            ) : (
              <iframe
                key={`${tab.id}:${tab.seq}`}
                ref={(element) => {
                  frameRefs.current.set(tab.id, element);
                }}
                className="page-frame"
                src={tab.src ?? 'about:blank'}
                title={tab.title || 'Browsed page'}
                sandbox={sandbox}
                allow="fullscreen; clipboard-write; autoplay"
                referrerPolicy="no-referrer"
                onLoad={() => handleFrameLoad(tab.id)}
              />
            )}
          </div>
        ))}
        {activeTab?.error ? (
          <div className="page-error-badge" title={activeTab.error}>
            Script error in page
          </div>
        ) : null}
      </main>

      {hoverUrl ? (
        <div className="status-bar" role="status">
          {hoverUrl}
        </div>
      ) : null}

      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}

      {menuOpen ? (
        <div className="menu-anchor" ref={menuRef}>
          <Menu
            isFullscreen={isFullscreen}
            canCopy={Boolean(currentUrl)}
            onClose={() => setMenuOpen(false)}
            onNewTab={() => openTab()}
            onOpenPanel={(next) => {
              setPanel(next);
              setMenuOpen(false);
            }}
            onCopy={() => void copyAddress()}
            onToggleFullscreen={toggleFullscreen}
            onNewSession={() => {
              setConfirm({
                title: 'Start a new browsing session?',
                message: 'This clears proxied cookies and site storage and signs you out of sites opened through OpenAccess.',
                confirmLabel: 'Start new session',
                action: () => void startNewSession(),
              });
            }}
            onShowAbout={() => setPanel('info')}
          />
        </div>
      ) : null}

      <PanelRouter
        panel={panel}
        onClose={() => setPanel(null)}
        config={config}
        session={session}
        settings={settings}
        bookmarks={bookmarks}
        history={history}
        onChangeSettings={setSettings}
        onOpenUrl={openInActiveTab}
        onRemoveBookmark={(id) => setBookmarks((current) => current.filter((bookmark) => bookmark.id !== id))}
        onRemoveHistory={(id) => setHistory((current) => current.filter((entry) => entry.id !== id))}
        onClearHistory={() => setHistory([])}
        onClearData={clearData}
        onNewSession={() =>
          setConfirm({
            title: 'Start a new browsing session?',
            message: 'This clears proxied cookies and site storage and signs you out of sites opened through OpenAccess.',
            confirmLabel: 'Start new session',
            action: () => void startNewSession(),
          })
        }
      />

      {mobileTabs ? (
        <div className="drawer-backdrop mobile-tabs" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setMobileTabs(false);
        }}>
          <div className="mobile-tab-sheet" role="dialog" aria-modal="true" aria-label="Tabs">
            <div className="drawer-header">
              <h2>Tabs</h2>
              <button type="button" className="icon-button" onClick={() => setMobileTabs(false)} aria-label="Close tabs">
                <CloseIcon size={17} />
              </button>
            </div>
            <ul className="mobile-tab-list">
              {tabs.map((tab) => (
                <li key={tab.id} className={tab.id === activeId ? 'is-active' : ''}>
                  <button type="button" className="mobile-tab-main" onClick={() => selectTab(tab.id)}>
                    <span className="mobile-tab-icon">
                      {tab.icon ? <img src={tab.icon} alt="" width={16} height={16} /> : <GlobeIcon size={16} />}
                    </span>
                    <span>
                      <span className="mobile-tab-title">{tab.title || 'New tab'}</span>
                      <span className="mobile-tab-host">{tab.url ? hostLabel(tab.url) : 'New tab'}</span>
                    </span>
                  </button>
                  <button type="button" className="icon-button subtle" onClick={() => closeTab(tab.id)} aria-label="Close tab">
                    <CloseIcon size={16} />
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="button primary full" onClick={() => { openTab(); setMobileTabs(false); }}>
              New tab
            </button>
          </div>
        </div>
      ) : null}

      {expired ? (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-icon">
              <ReloadIcon size={20} />
            </div>
            <h2>Your browsing session ended</h2>
            <p>
              Proxied sessions expire after inactivity and when the server restarts. Start a new session to keep
              browsing. Pages already open will need to be reloaded.
            </p>
            <div className="modal-actions">
              <button type="button" className="button primary" onClick={() => void startNewSession()}>
                Start a new session
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirm ? (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-icon">
              <ShieldIcon size={20} />
            </div>
            <h2>{confirm.title}</h2>
            <p>{confirm.message}</p>
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="button danger" onClick={confirm.action}>
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
