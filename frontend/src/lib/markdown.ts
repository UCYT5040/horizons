// Tiny inline-markdown renderer for short, admin-authored copy (event
// taglines/descriptions/joinInfo, FAQ answers). Unlike the announcement/README
// paths — which run full `marked` + DOMPurify — these strings only ever need
// links, bold, and line breaks, so we keep the lightweight regex renderer but
// make it XSS-safe:
//
//   1. HTML-escape the whole string FIRST, so any raw markup in the source
//      (e.g. `<img src=x onerror=...>`) renders as inert text, never live DOM.
//   2. Apply the inline-markdown transforms on the escaped string.
//   3. Restrict link targets to http(s)/mailto/relative/anchor so a
//      `[x](javascript:alert(1))` link can't smuggle a script URI.
//
// The output is trusted for `{@html}` because every code path that reaches an
// HTML sink here has been escaped or scheme-checked.

export function escapeHtml(value: string): string {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

// Allow only schemes that can't execute script. Anything else (javascript:,
// data:, vbscript:, …) falls back to an inert `#`.
const SAFE_URL = /^(https?:|mailto:|\/|#|\.)/i;

export function parseInlineMarkdown(text: string): string {
	if (!text) return '';
	return escapeHtml(text)
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
			// `label` and `href` are already HTML-escaped by escapeHtml above, so
			// they can't break out of the tag/attribute; we only need to reject
			// dangerous URL schemes.
			const trimmed = href.trim();
			const safe = SAFE_URL.test(trimmed) ? trimmed : '#';
			return `<a href="${safe}" class="underline hover:opacity-70">${label}</a>`;
		})
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\n/g, '<br />');
}
