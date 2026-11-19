import type { ReactNode } from 'react';
import { SEARCH_ENGINES, hostLabel } from '../../shared/url';
import type { Bookmark, ClientConfig, HistoryEntry, Panel, SessionInfo, Settings, ThemeSetting } from '../types';
import {
  ArrowUpRightIcon,
  BookmarkIcon,
  CloseIcon,
  GlobeIcon,
  HistoryIcon,
  InfoIcon,
  SettingsIcon,
  ShieldIcon,
  TrashIcon,
} from '../icons';

interface DrawerProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

export function Drawer({ title, onClose, children, wide = false }: DrawerProps) {
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className={`drawer${wide ? ' drawer-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
            <CloseIcon size={17} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

interface PanelRouterProps {
  panel: Panel | null;
  onClose: () => void;
  config: ClientConfig;
  session: SessionInfo | null;
  settings: Settings;
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  onChangeSettings: (next: Settings) => void;
  onOpenUrl: (url: string) => void;
  onRemoveBookmark: (id: string) => void;
  onRemoveHistory: (id: string) => void;
  onClearHistory: () => void;
  onClearData: () => void;
  onNewSession: () => void;
}

export function PanelRouter(props: PanelRouterProps) {
  const { panel, onClose } = props;
  if (!panel) return null;

  if (panel === 'bookmarks') {
    return (
      <Drawer title="Bookmarks" onClose={onClose}>
        <PanelIcon icon={<BookmarkIcon size={16} />} />
        {props.bookmarks.length === 0 ? (
          <p className="empty-state">
            No bookmarks yet. Use the star in the address bar (or <kbd>Ctrl</kbd> + <kbd>D</kbd>) while viewing a page.
          </p>
        ) : (
          <ul className="list">
            {props.bookmarks.map((bookmark) => (
              <li key={bookmark.id} className="list-row">
                <button type="button" className="list-main" onClick={() => props.onOpenUrl(bookmark.url)}>
                  <span className="list-title">{bookmark.title}</span>
                  <span className="list-sub">{hostLabel(bookmark.url)}</span>
                </button>
                <button
                  type="button"
                  className="icon-button subtle"
                  onClick={() => props.onRemoveBookmark(bookmark.id)}
                  aria-label={`Remove bookmark ${bookmark.title}`}
                >
                  <TrashIcon size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
    );
  }

  if (panel === 'history') {
    return (
      <Drawer title="History" onClose={onClose}>
        <PanelIcon icon={<HistoryIcon size={16} />} />
        <label className="switch-row">
          <span>
            <span className="switch-title">Keep history on this device</span>
            <span className="switch-sub">Stored only in this browser. Never sent to the server.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={props.settings.saveHistory}
            onChange={(event) => props.onChangeSettings({ ...props.settings, saveHistory: event.target.checked })}
          />
        </label>
        {props.history.length === 0 ? (
          <p className="empty-state">No history recorded on this device.</p>
        ) : (
          <>
            <div className="panel-actions">
              <button type="button" className="button secondary small" onClick={props.onClearHistory}>
                Clear history
              </button>
            </div>
            <ul className="list">
              {props.history.map((entry) => (
                <li key={entry.id} className="list-row">
                  <button type="button" className="list-main" onClick={() => props.onOpenUrl(entry.url)}>
                    <span className="list-title">{entry.title}</span>
                    <span className="list-sub">{hostLabel(entry.url)}</span>
                  </button>
                  <span className="list-time">
                    {new Date(entry.visitedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <button
                    type="button"
                    className="icon-button subtle"
                    onClick={() => props.onRemoveHistory(entry.id)}
                    aria-label={`Remove ${entry.title} from history`}
                  >
                    <CloseIcon size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Drawer>
    );
  }

  if (panel === 'settings') {
    return (
      <Drawer title="Settings" onClose={onClose} wide>
        <PanelIcon icon={<SettingsIcon size={16} />} />

        <section className="settings-section">
          <h3>Appearance</h3>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as ThemeSetting[]).map((theme) => (
              <button
                key={theme}
                type="button"
                role="radio"
                aria-checked={props.settings.theme === theme}
                className={props.settings.theme === theme ? 'is-selected' : ''}
                onClick={() => props.onChangeSettings({ ...props.settings, theme })}
              >
                {theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>Search</h3>
          <label className="field">
            <span>Default search engine</span>
            <select
              value={props.settings.searchEngine}
              onChange={(event) => props.onChangeSettings({ ...props.settings, searchEngine: event.target.value })}
            >
              {SEARCH_ENGINES.map((engine) => (
                <option key={engine.id} value={engine.id}>
                  {engine.name}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="settings-section">
          <h3>Home page</h3>
          <div className="segmented" role="radiogroup" aria-label="Home page">
            <button
              type="button"
              role="radio"
              aria-checked={props.settings.homeMode === 'newtab'}
              className={props.settings.homeMode === 'newtab' ? 'is-selected' : ''}
              onClick={() => props.onChangeSettings({ ...props.settings, homeMode: 'newtab' })}
            >
              New tab page
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={props.settings.homeMode === 'url'}
              className={props.settings.homeMode === 'url' ? 'is-selected' : ''}
              onClick={() => props.onChangeSettings({ ...props.settings, homeMode: 'url' })}
            >
              Custom address
            </button>
          </div>
          {props.settings.homeMode === 'url' ? (
            <label className="field">
              <span>Home address</span>
              <input
                type="url"
                value={props.settings.homeUrl}
                placeholder="https://example.com"
                onChange={(event) => props.onChangeSettings({ ...props.settings, homeUrl: event.target.value })}
              />
            </label>
          ) : null}
        </section>

        <section className="settings-section">
          <h3>Privacy</h3>
          <label className="switch-row">
            <span>
              <span className="switch-title">Store browsing history on this device</span>
              <span className="switch-sub">Only in this browser’s localStorage; the server does not record it.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={props.settings.saveHistory}
              onChange={(event) => props.onChangeSettings({ ...props.settings, saveHistory: event.target.checked })}
            />
          </label>
          <div className="panel-actions">
            <button type="button" className="button danger small" onClick={props.onClearData}>
              <TrashIcon size={15} /> Clear browsing data
            </button>
          </div>
          <p className="fine-print">
            Clearing data ends the proxied session on the server (cookies and site storage), removes local bookmarks and
            history, and starts a fresh session. It does not affect your normal browser.
          </p>
        </section>

        <section className="settings-section">
          <h3>Session</h3>
          <dl className="facts">
            <div>
              <dt>Content mode</dt>
              <dd>{props.config.mode === 'isolated' ? 'Separate content host' : 'Sandboxed (opaque origin)'}</dd>
            </div>
            <div>
              <dt>Session token</dt>
              <dd className="mono">{props.session ? props.session.token.slice(0, 10) : '—'}…</dd>
            </div>
            <div>
              <dt>Idle timeout</dt>
              <dd>{props.config.limits.sessionIdleMinutes} minutes</dd>
            </div>
            <div>
              <dt>Response limit</dt>
              <dd>{props.config.limits.maxResponseMb} MB</dd>
            </div>
            <div>
              <dt>Upload limit</dt>
              <dd>{props.config.limits.maxUploadMb} MB</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>OpenAccess {props.config.version}</dd>
            </div>
          </dl>
          <div className="panel-actions">
            <button type="button" className="button secondary small" onClick={props.onNewSession}>
              Start a new session
            </button>
          </div>
        </section>
      </Drawer>
    );
  }

  return (
    <Drawer title="About OpenAccess" onClose={onClose} wide>
      <PanelIcon icon={<InfoIcon size={16} />} />
      <div className="info-hero">
        <ShieldIcon size={22} />
        <div>
          <h3>Websites run on the server, not on your device.</h3>
          <p>
            OpenAccess fetches each page, rewrites its links and scripts, and serves it back through this window. Your
            real IP address and browser fingerprint are never sent to the destination site.
          </p>
        </div>
      </div>

      <section className="settings-section">
        <h3>What works well</h3>
        <ul className="tick-list">
          <li>Static sites, documentation, news, wikis and public information portals.</li>
          <li>Most JavaScript-rendered sites, including client-side routing and API requests.</li>
          <li>Forms, redirects, cookies and multi-page log-ins.</li>
          <li>WebSockets (chat, live data), server-sent events, media with range requests.</li>
          <li>Multiple tabs that share one cookie jar, the way a normal browser profile does.</li>
        </ul>
      </section>

      <section className="settings-section">
        <h3>Known limitations</h3>
        <ul className="limit-list">
          <li>Pages that refuse to be framed, or scripts that navigate the top window, may not load.</li>
          <li>Proxied sites share one session; do not open untrusted pages alongside logged-in ones.</li>
          <li>Some single sign-on providers, CAPTCHAs and bot checks will reject proxied traffic.</li>
          <li>Service workers, DRM video, WebAuthn/passkeys and some WebGL/GPU features are unavailable or unstable.</li>
          <li>Cross-origin isolated features (SharedArrayBuffer, high-resolution timers) are disabled.</li>
          <li>Session cookies are stored in server memory and expire after {props.config.limits.sessionIdleMinutes} minutes idle.</li>
          <li>Downloads work for most files, but very large transfers count against the deployment’s bandwidth budget.</li>
        </ul>
      </section>

      <section className="settings-section">
        <h3>Privacy</h3>
        <p className="fine-print">
          OpenAccess does not require an account and does not sell data. Request logs are off by default and the proxy
          never stores full browsing history server-side; cookies and site storage exist only for your active session.
          The deployment operator can see aggregate traffic volume and must be trusted, exactly like any other web
          proxy. For sensitive accounts, use your own browser.
        </p>
      </section>

      <div className="panel-actions">
        <a className="button secondary small" href="https://github.com/MeYashverma/OpenAccess" target="_blank" rel="noreferrer noopener">
          Source code <ArrowUpRightIcon size={14} />
        </a>
        <a className="button secondary small" href="https://github.com/MeYashverma/OpenAccess/blob/main/docs/SECURITY.md" target="_blank" rel="noreferrer noopener">
          Security model <ArrowUpRightIcon size={14} />
        </a>
      </div>
    </Drawer>
  );
}

function PanelIcon({ icon }: { icon: ReactNode }) {
  return <div className="panel-icon">{icon}</div>;
}

/** Small "open site" button reused by new-tab surfaces. */
export function SiteBadge({ url }: { url: string }) {
  return (
    <span className="site-badge">
      <GlobeIcon size={13} /> {hostLabel(url)}
    </span>
  );
}
