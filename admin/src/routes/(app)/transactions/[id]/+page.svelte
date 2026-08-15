<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { ArrowLeft, ExternalLink } from 'lucide-svelte';
	import { Button, Card, Skeleton } from '$lib/components';
	import { api } from '$lib/api';
	import { ensureUser } from '$lib/auth';
	import { hasRole } from '$lib/roles';
	import { kindLabel, kindColor, type TransactionKind } from '$lib/transactionKind';

	interface TransactionDetail {
		transactionId: number;
		userId: number;
		kind: TransactionKind;
		itemDescription: string;
		cost: number;
		isFulfilled: boolean;
		fulfilledAt: string | null;
		refundedAt: string | null;
		createdAt: string;
		adminNote: string | null;
		item: {
			itemId: number;
			name: string;
			description: string | null;
			imageUrl: string | null;
			cost: number;
			shopId: number | null;
			shopSlug: string | null;
		} | null;
		variant: { variantId: number; name: string; cost: number; isActive: boolean } | null;
		event: { eventId: number; title: string; slug: string } | null;
		user: {
			userId: number;
			firstName: string | null;
			lastName: string | null;
			email: string;
			slackUserId: string | null;
			slackUsername: string | null;
			addressLine1: string | null;
			addressLine2: string | null;
			city: string | null;
			state: string | null;
			country: string | null;
			zipCode: string | null;
			balance: number;
		};
	}

	let transactionId = $derived(parseInt(page.params.id ?? '', 10));

	let txn = $state<TransactionDetail | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	let busy = $state<'fulfill' | 'unfulfill' | 'refund' | null>(null);

	let me = $state<{ roles?: string[] } | null>(null);
	// Refunds move currency, so they stay admin-only — fulfillers never see the
	// button, and the backend rejects them at the guard regardless.
	let canRefund = $derived(hasRole(me?.roles, 'admin'));

	// Note editor state.
	let noteDraft = $state('');
	let editingNote = $state(false);
	let savingNote = $state(false);
	let noteError = $state<string | null>(null);

	// The (app) layout gates children behind an async auth fetch, so afterNavigate
	// never fires on a cold load — both hooks are needed. Guarding on the loaded
	// id keeps a same-route navigation from refetching.
	let loadedId: number | null = null;
	function loadIfNeeded() {
		if (!Number.isFinite(transactionId)) {
			loading = false;
			error = 'Invalid transaction id';
			return;
		}
		if (transactionId === loadedId) return;
		loadedId = transactionId;
		loading = true;
		error = null;
		actionError = null;
		editingNote = false;
		txn = null;
		void loadPage();
	}

	onMount(loadIfNeeded);
	afterNavigate(loadIfNeeded);

	async function loadPage() {
		me = await ensureUser();
		await loadTransaction();
	}

	async function loadTransaction() {
		loading = true;
		try {
			const { data, error: err } = await api.GET('/api/shop/admin/transactions/{id}', {
				params: { path: { id: transactionId } }
			});
			if (err || !data) throw new Error('Failed to load transaction');
			txn = data as unknown as TransactionDetail;
			// Refetches happen after fulfil/unfulfil too — don't stomp a note the
			// user is part-way through typing.
			if (!editingNote) noteDraft = txn.adminNote ?? '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load transaction';
		} finally {
			loading = false;
		}
	}

	function formatDateTime(d: string): string {
		return new Date(d).toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function fullName(u: TransactionDetail['user']): string {
		return [u.firstName, u.lastName].filter(Boolean).join(' ') || '—';
	}

	function targetLabel(t: TransactionDetail): string {
		if (t.event) return t.event.title;
		if (t.item) return t.item.name;
		if (t.kind === 'AdminAdjustment') return t.cost < 0 ? 'Hours awarded' : 'Hours deducted';
		return t.itemDescription;
	}

	// Only shop purchases are shippable, so only they get a fulfilment toggle —
	// same rule the ledger applies. Event tickets and admin adjustments carry the
	// isFulfilled column but nothing ever ships for them.
	let isFulfillable = $derived(txn?.kind === 'ShopItem');

	// True when the buyer has given us nothing to ship to — worth calling out on
	// a page whose whole job is getting physical goods out the door.
	let hasAddress = $derived(
		!!txn &&
			!!(
				txn.user.addressLine1 ||
				txn.user.addressLine2 ||
				txn.user.city ||
				txn.user.state ||
				txn.user.zipCode ||
				txn.user.country
			)
	);

	async function handleFulfill() {
		if (!txn) return;
		busy = 'fulfill';
		actionError = null;
		try {
			const { error: err } = await api.PUT('/api/shop/admin/transactions/{id}/fulfill', {
				params: { path: { id: txn.transactionId } }
			});
			if (err) throw new Error('Failed to mark fulfilled');
			await loadTransaction();
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Action failed';
		} finally {
			busy = null;
		}
	}

	async function handleUnfulfill() {
		if (!txn) return;
		const ok =
			typeof window !== 'undefined'
				? window.confirm(
						`Mark this transaction as NOT fulfilled?\n\n` +
							`User: ${fullName(txn.user)} (${txn.user.email})\n` +
							`Item: ${targetLabel(txn)}`
					)
				: true;
		if (!ok) return;

		busy = 'unfulfill';
		actionError = null;
		try {
			const { error: err } = await api.DELETE('/api/shop/admin/transactions/{id}/fulfill', {
				params: { path: { id: txn.transactionId } }
			});
			if (err) throw new Error('Failed to unfulfill');
			await loadTransaction();
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Action failed';
		} finally {
			busy = null;
		}
	}

	async function handleRefund() {
		if (!txn) return;
		const balanceEffect =
			txn.cost > 0
				? `Refunding returns ${txn.cost}h to the user (their balance increases).`
				: `Reversing this removes the ${-txn.cost}h that was awarded (their balance decreases).`;
		const ok =
			typeof window !== 'undefined'
				? window.confirm(
						`${txn.kind === 'AdminAdjustment' ? 'Reverse' : 'Refund'} this transaction?\n\n` +
							`User: ${fullName(txn.user)} (${txn.user.email})\n` +
							`${kindLabel(txn.kind)}: ${targetLabel(txn)}\n` +
							`Cost: ${txn.cost}h\n\n` +
							balanceEffect
					)
				: true;
		if (!ok) return;

		busy = 'refund';
		actionError = null;
		try {
			const { error: err } = await api.DELETE('/api/shop/admin/transactions/{id}', {
				params: { path: { id: txn.transactionId } }
			});
			if (err) throw new Error('Failed to refund');
			await loadTransaction();
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Action failed';
		} finally {
			busy = null;
		}
	}

	function startEditNote() {
		noteDraft = txn?.adminNote ?? '';
		editingNote = true;
		noteError = null;
	}

	async function saveNote() {
		if (!txn) return;
		savingNote = true;
		noteError = null;
		try {
			const { data, error: err } = await api.PUT('/api/shop/admin/transactions/{id}/note', {
				params: { path: { id: txn.transactionId } },
				body: { content: noteDraft }
			});
			if (err || !data) throw new Error('Failed to save note');
			txn = data as unknown as TransactionDetail;
			noteDraft = txn.adminNote ?? '';
			editingNote = false;
		} catch (e) {
			noteError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			savingNote = false;
		}
	}
</script>

<svelte:head>
	<title>Transaction #{transactionId} · Horizons Admin</title>
</svelte:head>

<div class="mx-auto flex max-w-4xl flex-col gap-4 p-4 font-dm">
	<a
		href="{base}/transactions"
		class="inline-flex w-fit items-center gap-1 text-xs text-ds-text-secondary hover:text-ds-text"
	>
		<ArrowLeft size={14} /> Back to transactions
	</a>

	{#if loading}
		<Skeleton class="h-8 w-48" />
		<Skeleton class="h-40 w-full" />
		<Skeleton class="h-40 w-full" />
	{:else if error}
		<Card class="border-ds-red p-4">
			<p class="m-0 text-sm text-ds-red">{error}</p>
		</Card>
	{:else if txn}
		<!-- Header -->
		<div class="flex flex-wrap items-center gap-3">
			<h1 class="m-0 font-mono text-xl font-semibold text-ds-text">#{txn.transactionId}</h1>
			<span
				class="inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium {kindColor(
					txn.kind
				)}"
			>
				{kindLabel(txn.kind)}
			</span>
			{#if txn.refundedAt}
				<span class="text-xs font-medium text-red-700 dark:text-red-300">
					Refunded {formatDateTime(txn.refundedAt)}
				</span>
			{:else if txn.isFulfilled}
				<span class="text-xs font-medium text-green-700 dark:text-green-300">
					Fulfilled{txn.fulfilledAt ? ` ${formatDateTime(txn.fulfilledAt)}` : ''}
				</span>
			{:else if isFulfillable}
				<span class="text-xs font-medium text-amber-700 dark:text-amber-300">Pending</span>
			{:else}
				<span class="text-xs text-ds-text-secondary">—</span>
			{/if}
		</div>

		{#if actionError}
			<Card class="border-ds-red p-3">
				<p class="m-0 text-sm text-ds-red">{actionError}</p>
			</Card>
		{/if}

		<!-- Actions -->
		<Card class="flex flex-wrap items-center gap-2 p-3">
			{#if txn.refundedAt}
				<p class="m-0 text-xs text-ds-text-secondary">
					This transaction was refunded and can no longer be fulfilled.
				</p>
			{:else}
				{#if isFulfillable && txn.isFulfilled}
					<Button onclick={handleUnfulfill} disabled={busy !== null}>
						{busy === 'unfulfill' ? 'Unfulfilling…' : 'Mark not fulfilled'}
					</Button>
				{:else if isFulfillable}
					<Button variant="approve" onclick={handleFulfill} disabled={busy !== null}>
						{busy === 'fulfill' ? 'Fulfilling…' : 'Mark fulfilled'}
					</Button>
				{/if}
				{#if canRefund}
					<Button variant="reject" onclick={handleRefund} disabled={busy !== null}>
						{busy === 'refund'
							? 'Refunding…'
							: txn.kind === 'AdminAdjustment'
								? 'Reverse'
								: 'Refund'}
					</Button>
				{/if}
				{#if !isFulfillable && !canRefund}
					<p class="m-0 text-xs text-ds-text-secondary">
						Nothing ships for a {kindLabel(txn.kind).toLowerCase()} transaction — no actions available.
					</p>
				{/if}
			{/if}
		</Card>

		<div class="grid gap-4 md:grid-cols-2">
			<!-- Purchase -->
			<Card class="flex flex-col gap-3 p-4">
				<h2 class="m-0 text-[11px] font-semibold tracking-wider text-ds-text-secondary uppercase">
					Purchase
				</h2>

				{#if txn.item?.imageUrl}
					<img
						src={txn.item.imageUrl}
						alt={txn.item.name}
						class="h-32 w-full rounded-md border border-ds-border object-contain"
					/>
				{/if}

				<dl class="m-0 flex flex-col gap-2 text-sm">
					<div class="flex justify-between gap-3">
						<dt class="text-ds-text-secondary">Item</dt>
						<dd class="m-0 text-right font-medium text-ds-text">{targetLabel(txn)}</dd>
					</div>
					{#if txn.variant}
						<div class="flex justify-between gap-3">
							<dt class="text-ds-text-secondary">Variant</dt>
							<dd class="m-0 text-right text-ds-text">
								{txn.variant.name}
								<span class="text-ds-text-secondary">({txn.variant.cost}h)</span>
								{#if !txn.variant.isActive}
									<span class="text-xs text-ds-text-placeholder"> · inactive</span>
								{/if}
							</dd>
						</div>
					{/if}
					{#if txn.item?.shopSlug}
						<div class="flex justify-between gap-3">
							<dt class="text-ds-text-secondary">Shop</dt>
							<dd class="m-0 text-right text-ds-text">{txn.item.shopSlug}</dd>
						</div>
					{/if}
					{#if txn.event}
						<div class="flex justify-between gap-3">
							<dt class="text-ds-text-secondary">Event</dt>
							<dd class="m-0 text-right text-ds-text">{txn.event.title} ({txn.event.slug})</dd>
						</div>
					{/if}
					<div class="flex justify-between gap-3">
						<dt class="text-ds-text-secondary">Cost charged</dt>
						<dd class="m-0 text-right font-mono text-ds-text">{txn.cost}h</dd>
					</div>
					{#if txn.item && txn.item.cost !== txn.cost}
						<div class="flex justify-between gap-3">
							<dt class="text-ds-text-secondary">Current list price</dt>
							<dd class="m-0 text-right font-mono text-ds-text-secondary">{txn.item.cost}h</dd>
						</div>
					{/if}
					<div class="flex justify-between gap-3">
						<dt class="text-ds-text-secondary">Purchased</dt>
						<dd class="m-0 text-right text-ds-text">{formatDateTime(txn.createdAt)}</dd>
					</div>
				</dl>

				{#if txn.item?.description}
					<p class="m-0 text-xs leading-relaxed text-ds-text-secondary">{txn.item.description}</p>
				{/if}

				<p class="m-0 text-xs text-ds-text-placeholder">
					Recorded as: {txn.itemDescription}
				</p>
			</Card>

			<!-- Buyer -->
			<Card class="flex flex-col gap-3 p-4">
				<h2 class="m-0 text-[11px] font-semibold tracking-wider text-ds-text-secondary uppercase">
					Buyer
				</h2>

				<dl class="m-0 flex flex-col gap-2 text-sm">
					<div class="flex justify-between gap-3">
						<dt class="text-ds-text-secondary">Name</dt>
						<dd class="m-0 text-right font-medium text-ds-text">{fullName(txn.user)}</dd>
					</div>
					<div class="flex justify-between gap-3">
						<dt class="text-ds-text-secondary">Email</dt>
						<dd class="m-0 text-right break-all text-ds-text">{txn.user.email}</dd>
					</div>
					{#if txn.user.slackUsername || txn.user.slackUserId}
						<div class="flex justify-between gap-3">
							<dt class="text-ds-text-secondary">Slack</dt>
							<dd class="m-0 text-right text-ds-text">
								{txn.user.slackUsername ?? txn.user.slackUserId}
							</dd>
						</div>
					{/if}
					<div class="flex justify-between gap-3">
						<dt class="text-ds-text-secondary">Current balance</dt>
						<dd class="m-0 text-right font-mono text-ds-text">{txn.user.balance}h</dd>
					</div>
				</dl>

				<div class="flex flex-col gap-1">
					<span class="text-[11px] font-semibold tracking-wider text-ds-text-secondary uppercase">
						Shipping address
					</span>
					{#if hasAddress}
						<div
							class="flex flex-col gap-0.5 rounded-md border border-ds-border bg-ds-surface2 p-2.5 text-[13px] text-ds-text"
						>
							{#if txn.user.addressLine1}<p class="m-0">{txn.user.addressLine1}</p>{/if}
							{#if txn.user.addressLine2}<p class="m-0">{txn.user.addressLine2}</p>{/if}
							<p class="m-0">
								{[txn.user.city, txn.user.state, txn.user.zipCode].filter(Boolean).join(', ')}
							</p>
							{#if txn.user.country}<p class="m-0">{txn.user.country}</p>{/if}
						</div>
					{:else}
						<p class="m-0 text-[13px] text-amber-700 italic dark:text-amber-300">
							No address on file — this can't be shipped yet.
						</p>
					{/if}
				</div>

				<a
					href="{base}/transactions?q={encodeURIComponent(txn.user.email)}"
					class="inline-flex w-fit items-center gap-1 text-xs text-ds-accent hover:underline"
				>
					All transactions for this user <ExternalLink size={12} />
				</a>
			</Card>
		</div>

		<!-- Admin note -->
		<Card class="flex flex-col gap-2 p-4">
			<div class="flex items-center justify-between gap-2">
				<h2 class="m-0 text-[11px] font-semibold tracking-wider text-ds-text-secondary uppercase">
					Admin note
				</h2>
				{#if !editingNote}
					<Button onclick={startEditNote}>Edit</Button>
				{/if}
			</div>

			{#if editingNote}
				<textarea
					class="min-h-[90px] w-full resize-y rounded-md border border-ds-border bg-ds-bg p-2 text-[13px] leading-relaxed text-ds-text focus:border-ds-accent focus:outline-none"
					bind:value={noteDraft}
					maxlength={1000}
					placeholder="Notes about this transaction — tracking numbers, sizing, why it's on hold…"
				></textarea>
				<div class="flex items-center gap-2">
					<Button variant="approve" onclick={saveNote} disabled={savingNote}>
						{savingNote ? 'Saving…' : 'Save'}
					</Button>
					<Button onclick={() => (editingNote = false)} disabled={savingNote}>Cancel</Button>
					{#if noteError}
						<span class="text-xs text-ds-red">{noteError}</span>
					{/if}
				</div>
			{:else if txn.adminNote?.trim()}
				<p class="m-0 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-ds-text">
					{txn.adminNote}
				</p>
			{:else}
				<p class="m-0 text-[13px] text-ds-text-placeholder italic">No note yet.</p>
			{/if}
		</Card>
	{/if}
</div>
