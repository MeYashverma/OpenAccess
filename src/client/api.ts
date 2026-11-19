import type { ClientConfig, SessionInfo } from './types';

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    let retryAfter: number | undefined;
    const header = response.headers.get('retry-after');
    if (header) retryAfter = Number(header);
    let detail = '';
    try {
      const body = (await response.json()) as { error?: string };
      detail = body.error ?? '';
    } catch {
      /* ignore */
    }
    throw new ApiError(detail || `Request failed (${response.status})`, response.status, retryAfter);
  }
  return (await response.json()) as T;
}

export async function fetchConfig(): Promise<ClientConfig> {
  return request<ClientConfig>('/api/config');
}

export async function createSession(): Promise<SessionInfo> {
  return request<SessionInfo>('/api/session', { method: 'POST', body: '{}' });
}

export async function validateSession(token: string): Promise<SessionInfo | null> {
  try {
    return await request<SessionInfo>(`/api/session/${encodeURIComponent(token)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function destroySession(token: string): Promise<void> {
  try {
    await request<{ ok: boolean }>(`/api/session/${encodeURIComponent(token)}`, { method: 'DELETE' });
  } catch {
    /* best effort */
  }
}

export { ApiError };
