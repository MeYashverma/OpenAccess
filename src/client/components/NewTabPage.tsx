import { useState } from 'react';
import { SEARCH_ENGINES, searchUrl, hostLabel } from '../../shared/url';
import type { Bookmark, ClientConfig, HistoryEntry, Settings } from '../types';
import { ArrowUpRightIcon, CloseIcon, GlobeIcon, SearchIcon, ShieldIcon } from '../icons';

interface NewTabPageProps {
  config: ClientConfig;
  settings: Settings;
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  showIntro: boolean;
  onDismissIntro: () => void;
  onSearch: (query: string) => void;
  onOpenUrl: (url: string) => void;
  onOpenPanel: (panel: 'bookmarks' | 'history' | 'info') => void;
}

export function NewTabPage({
  config,
  settings,
  bookmarks,
  history,
  showIntro,
  onDismissIntro,
  onSearch,
  onOpenUrl,
  onOpenPanel,
}: NewTabPageProps) {
  const [query, setQuery] = useState('');
  const engine = SEARCH_ENGINES.find((entry) => entry.id === settings.searchEngine) ?? SEARCH_ENGINES[0]!;
  const quickLinks = bookmarks.slice(0, 8);
  const recent = settings.saveHistory ? history.slice(0, 5) : [];

  return (
    <div className="newtab">
      <div className="newtab-inner">
        <div className="newtab-hero">
          <div className="wordmark">
            <span className="wordmark-mark">
              <GlobeIcon size={22} />
            </span>
            <span className="wordmark-text">
              Open<span>Access</span>
            </span>
          </div>
          <p className="newtab-tagline">
            A browser that runs in your browser. Websites are rendered through this server, so nothing is installed
            on your device.
          </p>

          <form
            className="newtab-search"
            onSubmit={(event) => {
              event.preventDefault();
              const value = query.trim();
              if (!value) return;
              const looksLikeUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || /^[^\s]+\.[a-zA-Z]{2,}/.test(value);
              if (looksLikeUrl) onOpenUrl(value.includes('://') ? value : `https://${value}`);
              else onSearch(searchUrl(engine.id, value));
            }}
          >
            <SearchIcon size={18} />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search with ${engine.name} or enter an address`}
              aria-label="Search the web or enter an address"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button type="submit" className="button primary" aria-label="Go">
              Go
            </button>
          </form>
          <div className="newtab-engine-hint">
            Press <kbd>Enter</kbd> to search · Set a different engine in Settings
          </div>
        </div>

        {showIntro ? (
          <section className="intro-card" aria-label="Getting started">
            <button type="button" className="intro-dismiss" aria-label="Dismiss" onClick={onDismissIntro}>
              <CloseIcon size={14} />
            </button>
            <div className="intro-title">
              <ShieldIcon size={18} />
              <span>How this browser protects you</span>
            </div>
            <ul className="intro-list">
              <li>Websites run through a server-side proxy. They never see your real IP address.</li>
              <li>No account, no extension, and no browsing history leaves this device.</li>
              <li>
                Proxied log-ins are isolated from your normal browser. Don’t enter banking or government credentials
                through a public proxy.
              </li>
            </ul>
            <button type="button" className="text-button" onClick={() => onOpenPanel('info')}>
              Read the full limitations
            </button>
          </section>
        ) : null}

        {quickLinks.length > 0 ? (
          <section className="newtab-section" aria-label="Bookmarks">
            <div className="section-heading">
              <h2>Bookmarks</h2>
              <button type="button" className="text-button" onClick={() => onOpenPanel('bookmarks')}>
                Edit
              </button>
            </div>
            <div className="quick-grid">
              {quickLinks.map((bookmark) => (
                <button
                  key={bookmark.id}
                  type="button"
                  className="quick-link"
                  onClick={() => onOpenUrl(bookmark.url)}
                  title={bookmark.url}
                >
                  <span className="quick-tile">{bookmark.title.slice(0, 1).toUpperCase() || '·'}</span>
                  <span className="quick-text">
                    <span className="quick-title">{bookmark.title}</span>
                    <span className="quick-host">{hostLabel(bookmark.url)}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {recent.length > 0 ? (
          <section className="newtab-section" aria-label="Recently visited">
            <div className="section-heading">
              <h2>Recently visited</h2>
              <button type="button" className="text-button" onClick={() => onOpenPanel('history')}>
                All history
              </button>
            </div>
            <ul className="recent-list">
              {recent.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="recent-item" onClick={() => onOpenUrl(entry.url)}>
                    <span className="recent-icon">
                      <GlobeIcon size={15} />
                    </span>
                    <span className="recent-title">{entry.title}</span>
                    <span className="recent-host">{hostLabel(entry.url)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="newtab-footer">
          <span className="status-chip">
            <span className={`status-dot ${config.mode === 'isolated' ? 'status-ok' : 'status-warn'}`} />
            {config.mode === 'isolated' ? 'Isolated content origin' : 'Sandboxed single-origin mode'}
          </span>
          <span className="status-chip">No tracking</span>
          <a className="status-chip status-link" href="https://github.com/MeYashverma/OpenAccess" target="_blank" rel="noreferrer noopener">
            Open source <ArrowUpRightIcon size={13} />
          </a>
          <span className="newtab-version">v{config.version}</span>
        </footer>
      </div>
    </div>
  );
}
