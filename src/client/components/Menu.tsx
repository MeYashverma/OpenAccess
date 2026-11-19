import type { Panel } from '../types';
import {
  BookmarkIcon,
  CheckIcon,
  CopyIcon,
  ExpandIcon,
  HistoryIcon,
  InfoIcon,
  PlusIcon,
  SessionIcon,
  SettingsIcon,
  ShieldIcon,
} from '../icons';

interface MenuProps {
  isFullscreen: boolean;
  canCopy: boolean;
  onClose: () => void;
  onNewTab: () => void;
  onOpenPanel: (panel: Panel) => void;
  onCopy: () => void;
  onToggleFullscreen: () => void;
  onNewSession: () => void;
  onShowAbout: () => void;
}

export function Menu({
  isFullscreen,
  canCopy,
  onClose,
  onNewTab,
  onOpenPanel,
  onCopy,
  onToggleFullscreen,
  onNewSession,
  onShowAbout,
}: MenuProps) {
  const item = (label: string, icon: React.ReactNode, action: () => void, hint?: string) => (
    <button
      type="button"
      className="menu-item"
      onClick={() => {
        action();
        onClose();
      }}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{label}</span>
      {hint ? <span className="menu-hint">{hint}</span> : null}
    </button>
  );

  return (
    <div className="menu" role="menu" aria-label="Browser menu">
      {item('New tab', <PlusIcon size={16} />, onNewTab, '⌘T')}
      {item('Bookmarks', <BookmarkIcon size={16} />, () => onOpenPanel('bookmarks'))}
      {item('History', <HistoryIcon size={16} />, () => onOpenPanel('history'))}
      <div className="menu-divider" />
      {item('Copy address', <CopyIcon size={16} />, onCopy, canCopy ? '⌘C' : undefined)}
      {item(
        isFullscreen ? 'Exit full screen' : 'Full screen',
        <ExpandIcon size={16} />,
        onToggleFullscreen,
      )}
      <div className="menu-divider" />
      {item('Settings', <SettingsIcon size={16} />, () => onOpenPanel('settings'))}
      {item('About & limitations', <InfoIcon size={16} />, onShowAbout)}
      <div className="menu-divider" />
      {item('Start a new session', <SessionIcon size={16} />, onNewSession)}
      <div className="menu-footer">
        <span className="menu-footer-icon">
          <ShieldIcon size={14} />
        </span>
        <span>
          Proxied browsing
          <span className="menu-footer-sub">
            <CheckIcon size={12} /> No tracking · HTTPS only
          </span>
        </span>
      </div>
    </div>
  );
}
