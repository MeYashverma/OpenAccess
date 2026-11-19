import type { TabState } from '../types';
import { CloseIcon, GlobeIcon, PlusIcon } from '../icons';

interface TabStripProps {
  tabs: TabState[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  compact?: boolean;
}

export function TabStrip({ tabs, activeId, onSelect, onClose, onNew, compact = false }: TabStripProps) {
  return (
    <div className={`tabstrip${compact ? ' tabstrip-compact' : ''}`} role="tablist" aria-label="Tabs">
      <div className="tabstrip-scroll">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`tab${active ? ' tab-active' : ''}`}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab.id);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(tab.id);
                }
              }}
              title={tab.url ?? 'New tab'}
            >
              <span className="tab-icon" aria-hidden="true">
                {tab.icon ? (
                  <img
                    src={tab.icon}
                    alt=""
                    width={16}
                    height={16}
                    onError={(event) => {
                      (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                ) : (
                  <GlobeIcon size={15} />
                )}
                {tab.loading ? <span className="tab-loading" /> : null}
              </span>
              <span className="tab-title">{tab.title || 'New tab'}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${tab.title || 'tab'}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <CloseIcon size={14} />
              </button>
            </div>
          );
        })}
        <button type="button" className="tab-new" aria-label="New tab" onClick={onNew} title="New tab (Ctrl+T)">
          <PlusIcon size={16} />
        </button>
      </div>
    </div>
  );
}
