import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './schema';
import { env } from '$env/dynamic/public';
import { browser } from '$app/environment';
import { base } from '$app/paths';

const getBaseUrl = () => {
	return env.PUBLIC_API_URL || 'http://localhost:3002';
};

export const api = createClient<paths>({
	baseUrl: getBaseUrl(),
	credentials: 'include'
});

// A 401 usually means the session is gone (expired or revoked). Bounce to the
// admin login once instead of letting every panel surface its own error.
// 403s are left to callers — they mean "authenticated but not allowed" and
// several pages probe admin-only endpoints as reviewers on purpose.
//
// Caveat: some backend endpoints surface an *upstream* auth failure (e.g. a
// rejected HACKATIME_API_KEY) as their own 401 even though the reviewer's
// session is perfectly valid. Bouncing on those loops forever — login sees a
// live session and redirects straight back, re-firing the same 401. So for any
// 401 that isn't from the session probe itself, re-check /me and only bounce
// when the session is genuinely dead.
const ME_PATH = '/api/user/auth/me';
let redirecting = false;
function bounceToLogin() {
	if (redirecting) return;
	redirecting = true;
	const next = encodeURIComponent(window.location.pathname + window.location.search);
	window.location.href = `${base}/login?next=${next}`;
}
const authRedirect: Middleware = {
	async onResponse({ request, response }) {
		if (!browser || response.status !== 401 || redirecting) return response;
		// The login page itself probes /me while signed out — never bounce it.
		if (window.location.pathname.startsWith(`${base}/login`)) return response;

		// A 401 on the session probe itself is an unambiguously dead session.
		if (request.url.endsWith(ME_PATH)) {
			bounceToLogin();
			return response;
		}

		// Any other 401 might be an upstream auth failure, not session death.
		// Confirm by re-probing /me; a valid session is left to the caller to
		// handle (panels degrade gracefully) rather than triggering a redirect.
		const { error } = await api.GET('/api/user/auth/me');
		if (error) bounceToLogin();
		return response;
	}
};
api.use(authRedirect);
