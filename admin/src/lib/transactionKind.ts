/**
 * Display helpers for `Transaction.kind`. Shared by the transaction ledger and
 * the transaction detail page so a kind pill looks the same in both places.
 *
 * `EventRsvp` exists in the backend enum but the RSVP system is disabled, so it
 * never reaches these surfaces — it falls through to the ticket styling.
 */
export type TransactionKind = 'ShopItem' | 'EventTicket' | 'AdminAdjustment';

export function kindLabel(k: TransactionKind): string {
	if (k === 'ShopItem') return 'Shop';
	if (k === 'AdminAdjustment') return 'Admin Adj';
	return 'Ticket';
}

export function kindColor(k: TransactionKind): string {
	if (k === 'ShopItem')
		return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200 border-blue-300/50 dark:border-blue-700/50';
	if (k === 'AdminAdjustment')
		return 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200 border-purple-300/50 dark:border-purple-700/50';
	return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200 border-emerald-300/50 dark:border-emerald-700/50';
}
