export type ThemeSetting = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemeSetting;
  searchEngine: string;
  homeMode: 'newtab' | 'url';
  homeUrl: string;
  saveHistory: boolean;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
}

export interface TabState {
  id: string;
  /** Real destination URL, or null for the new-tab page. */
  url: string | null;
  /** Proxied iframe URL. */
  src: string | null;
  title: string;
  icon: string | null;
  loading: boolean;
  hasRuntime: boolean;
  error: string | null;
  createdAt: number;
  /** Bumped to force a frame remount (navigation, reload, new session). */
  seq: number;
}

export interface ClientConfig {
  version: string;
  mode: 'isolated' | 'shared';
  contentOrigin: string;
  features: { websockets: boolean; serverStorage: boolean };
  limits: {
    maxUploadMb: number;
    maxResponseMb: number;
    sessionIdleMinutes: number;
    sessionMaxHours: number;
    rateLimitPerMinute: number;
  };
}

export interface SessionInfo {
  token: string;
  expiresAt: number;
  idleExpiresAt?: number;
  mode: 'isolated' | 'shared';
  contentOrigin: string;
}

export type Panel = 'bookmarks' | 'history' | 'settings' | 'info';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  searchEngine: 'duckduckgo',
  homeMode: 'newtab',
  homeUrl: '',
  saveHistory: true,
};
