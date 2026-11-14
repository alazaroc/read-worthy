import { fetchAuthSession } from 'aws-amplify/auth';

const BASE_URL = (import.meta.env.VITE_API_URL as string).replace(/\/$/, '');

// Neither fetch nor Amplify's token refresh has a built-in timeout. On iOS a
// PWA resumed from the background can leave either promise pending forever,
// which froze the UI on its loading skeleton with no request ever reaching
// the API. Every await below is bounded so the page always reaches an error
// state with a Retry button.
export const AUTH_TIMEOUT_MS = 8_000;
export const REQUEST_TIMEOUT_MS = 12_000; // Lambda timeout is 10 s

export class SessionTimeoutError extends Error {
  constructor() {
    super('Your session could not be refreshed. Reload the app and try again.');
    this.name = 'SessionTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getAuthHeader(): Promise<Record<string, string>> {
  try {
    const session = await withTimeout(
      fetchAuthSession(),
      AUTH_TIMEOUT_MS,
      () => new SessionTimeoutError()
    );
    const token = session.tokens?.idToken?.toString();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch (err) {
    // A stalled refresh is not transient: Amplify reuses the same pending
    // refresh promise, so retrying would just wait again. Surface it.
    if (err instanceof SessionTimeoutError) throw err;
    return {};
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let lastError: Error = new Error('Request failed');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Exponential backoff with jitter between retries (250ms, 500ms, 1s, 2s…).
    if (attempt > 0) await sleep(2 ** (attempt - 1) * 250 + Math.random() * 200);

    // The token is recomputed on each attempt: a transient session hiccup
    // self-heals on retry (avoids a 401 from the authorizer → "Failed to fetch").
    const authHeaders = await getAuthHeader();

    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      lastError = new Error('Could not reach the server. Check your connection and try again.');
      continue;
    }

    // 429 (throttling) and 5xx are transient → retry with backoff.
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`The server is overloaded (${res.status}).`);
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(err.message ?? `Error ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  throw lastError;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
