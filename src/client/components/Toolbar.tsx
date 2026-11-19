import { useRef } from 'react';
import {
  BackIcon,
  BookmarkIcon,
  CopyIcon,
  ForwardIcon,
  GlobeIcon,
  HomeIcon,
  LockIcon,
  MenuIcon,
  ReloadIcon,
  SearchIcon,
  StarIcon,
  StopIcon,
} from '../icons';

export interface Suggestion {
  kind: 'bookmark' | 'history' | 'search';
  title: string;
  url: string;
}

interface ToolbarProps {
  address: string;
  addressFocused: boolean;
  loading: boolean;
  currentUrl: string | null;
  bookmarked: boolean;
  suggestions: Suggestion[];
  suggestionsOpen: boolean;
  onFocusAddress: () => void;
  onBlurAddress: () => void;
  onChangeAddress: (value: string) => void;
  onSubmit: () => void;
  onSelectSuggestion: (suggestion: Suggestion) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onHome: () => void;
  onToggleBookmark: () => void;
  onCopy: () => void;
  onOpenMenu: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function securityFor(url: string | null) {
  if (!url) return { icon: <SearchIcon size={15} />, label: 'Search or enter an address', tone: 'neutral' };
  if (url.startsWith('https://')) return { icon: <LockIcon size={15} />, label: 'Secure connection to the destination through OpenAccess', tone: 'secure' };
  return { icon: <GlobeIcon size={15} />, label: 'Not a secure connection (http)', tone: 'insecure' };
}

export function Toolbar(props: ToolbarProps) {
  const {
    address,
    addressFocused,
    loading,
    currentUrl,
    bookmarked,
    suggestions,
    suggestionsOpen,
    onFocusAddress,
    onBlurAddress,
    onChangeAddress,
    onSubmit,
    onSelectSuggestion,
    onBack,
    onForward,
    onReload,
    onStop,
    onHome,
    onToggleBookmark,
    onCopy,
    onOpenMenu,
    inputRef,
  } = props;

  const security = securityFor(currentUrl);
  const blurTimer = useRef<number | null>(null);

  return (
    <div className="toolbar">
      <div className="toolbar-nav">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back" title="Back (Alt+Left)">
          <BackIcon size={18} />
        </button>
        <button type="button" className="icon-button" onClick={onForward} aria-label="Forward" title="Forward (Alt+Right)">
          <ForwardIcon size={18} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={loading ? onStop : onReload}
          aria-label={loading ? 'Stop loading' : 'Reload'}
          title={loading ? 'Stop loading' : 'Reload (Ctrl+R)'}
        >
          {loading ? <StopIcon size={17} /> : <ReloadIcon size={17} />}
        </button>
        <button type="button" className="icon-button home-button" onClick={onHome} aria-label="Home" title="Home">
          <HomeIcon size={17} />
        </button>
      </div>

      <div className={`omnibox${addressFocused ? ' omnibox-focused' : ''}`}>
        <span className={`omnibox-security omnibox-${security.tone}`} title={security.label} aria-hidden="true">
          {security.icon}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={address}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          inputMode="url"
          enterKeyHint="go"
          aria-label="Address and search bar"
          placeholder="Search or enter an address"
          onChange={(event) => onChangeAddress(event.target.value)}
          onFocus={onFocusAddress}
          onBlur={() => {
            blurTimer.current = window.setTimeout(onBlurAddress, 120);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onBlurAddress();
              (event.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
        <button
          type="button"
          className={`omnibox-action${bookmarked ? ' is-active' : ''}`}
          onClick={onToggleBookmark}
          aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
          title={bookmarked ? 'Remove bookmark' : 'Bookmark this page (Ctrl+D)'}
          disabled={!currentUrl}
        >
          <StarIcon size={16} filled={bookmarked} />
        </button>
        <button
          type="button"
          className="omnibox-action copy-action"
          onClick={onCopy}
          aria-label="Copy address"
          title="Copy address"
          disabled={!currentUrl}
        >
          <CopyIcon size={16} />
        </button>

        {suggestionsOpen && suggestions.length > 0 ? (
          <div className="suggestions" role="listbox" aria-label="Suggestions">
            {suggestions.map((suggestion) => (
              <button
                key={`${suggestion.kind}-${suggestion.url}`}
                type="button"
                role="option"
                aria-selected={false}
                className="suggestion"
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
                  onSelectSuggestion(suggestion);
                }}
              >
                <span className="suggestion-icon">
                  {suggestion.kind === 'search' ? <SearchIcon size={15} /> : suggestion.kind === 'bookmark' ? <BookmarkIcon size={15} /> : <GlobeIcon size={15} />}
                </span>
                <span className="suggestion-text">
                  <span className="suggestion-title">{suggestion.title}</span>
                  <span className="suggestion-url">{suggestion.url.replace(/^https?:\/\//, '')}</span>
                </span>
                {suggestion.kind === 'search' ? <span className="suggestion-hint">Search</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="toolbar-actions">
        <button type="button" className="icon-button" onClick={onOpenMenu} aria-label="Open menu" title="Menu">
          <MenuIcon size={18} />
        </button>
      </div>
    </div>
  );
}
