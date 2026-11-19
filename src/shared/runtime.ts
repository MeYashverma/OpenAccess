/** Protocol shared by the server-rendered bootstrap and the injected runtime. */

export interface RuntimeBootstrap {
  token: string;
  /** Real URL of the document at the time it was rewritten. */
  target: string;
  contentOrigin: string;
  parentOrigin: string;
  mode: 'isolated' | 'shared';
  /** document.cookie snapshot at render time (non-HttpOnly cookies only). */
  cookie: string;
  /** HMAC-signed handle binding this document to its target host. */
  handle: string;
  /** Whether the server can persist localStorage-style data. */
  storage: boolean;
}

export type RuntimeToParentMessage =
  | { __oa: true; type: 'ready'; url: string; title: string }
  | { __oa: true; type: 'navigate'; url: string; title: string }
  | { __oa: true; type: 'title'; title: string }
  | { __oa: true; type: 'icon'; href: string | null }
  | { __oa: true; type: 'loading'; loading: boolean }
  | { __oa: true; type: 'open-tab'; url: string; background?: boolean; replace?: boolean }
  | { __oa: true; type: 'link'; url: string | null }
  | { __oa: true; type: 'shortcut'; action: string }
  | { __oa: true; type: 'error'; message: string }
  | { __oa: true; type: 'storage-unavailable' };

export type ParentToRuntimeMessage = {
  __oaCommand: true;
  command: 'back' | 'forward' | 'reload' | 'stop' | 'navigate' | 'focus';
  url?: string;
};
