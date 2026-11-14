import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAuthSession = vi.fn();
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: () => fetchAuthSession() }));

const session = { tokens: { idToken: { toString: () => 'token' } } };
const never = () => new Promise<never>(() => {});

async function loadApi() {
  vi.stubEnv('VITE_API_URL', 'https://api.example.com');
  return import('./api');
}

describe('api client timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    fetchAuthSession.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('fails with a session error instead of hanging when the token refresh never settles', async () => {
    fetchAuthSession.mockImplementation(never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { api, AUTH_TIMEOUT_MS } = await loadApi();

    const result = api.get('/documents');
    const assertion = expect(result).rejects.toThrow(/session could not be refreshed/);
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS);

    await assertion;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a request that never answers and ends in an error after retries', async () => {
    fetchAuthSession.mockResolvedValue(session);
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await loadApi();

    const result = api.get('/documents');
    const assertion = expect(result).rejects.toThrow(/Could not reach the server/);
    await vi.advanceTimersByTimeAsync(120_000);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('recovers when a stalled request is followed by a good one', async () => {
    fetchAuthSession.mockResolvedValue(session);
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
          })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await loadApi();

    const result = api.get<{ ok: boolean }>('/documents');
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toEqual({ ok: true });
  });
});
