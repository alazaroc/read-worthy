/**
 * Synchronous hint of whether a session may exist, read before any network call.
 * Lets the auth bootstrap start in "loading" only when there is something to
 * restore (stored Cognito tokens or an OAuth callback in flight), so returning
 * users see the loader straight into their app and visitors see the landing
 * immediately, with no intermediate flash of the wrong screen.
 */
export function hasPendingSession(): boolean {
  try {
    if (new URLSearchParams(window.location.search).has('code')) return true;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('CognitoIdentityServiceProvider.') && key.endsWith('.LastAuthUser')) {
        return true;
      }
    }
  } catch {
    // Storage unavailable (private mode): fall back to waiting for the real check.
    return true;
  }
  return false;
}
