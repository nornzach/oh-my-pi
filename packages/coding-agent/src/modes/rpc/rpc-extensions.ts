/**
 * Data builders for extension-feature RPC commands (usage, settings, providers).
 * Keeps rpc-mode.ts switch cases thin; all projection logic lives here.
 */
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai";
import {
	getDefault,
	isCredential,
	RESTART_REQUIRED_SETTING_PATHS,
	SETTINGS_SCHEMA,
	SETTING_TABS,
	TAB_GROUPS,
	TAB_METADATA,
	TUI_ONLY_SETTING_PATHS,
	type SettingPath,
} from "../../config/settings-schema";
import type { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import type {
	RpcProviderInfo,
	RpcProvidersResult,
	RpcSettingEntry,
	RpcSettingsSchemaResult,
	RpcUsageLimit,
	RpcUsageReport,
	RpcUsageResult,
	RpcUsageSessionStats,
} from "./rpc-types";

// ============================================================================
// Usage
// ============================================================================

function mapUsageLimit(limit: UsageReport["limits"][number]): RpcUsageLimit {
	const fraction = resolveUsedFraction(limit);
	return {
		id: limit.id,
		label: limit.label,
		usedFraction: fraction,
		used: limit.amount.used,
		limit: limit.amount.limit,
		unit: limit.amount.unit,
		remainingFraction: limit.amount.remainingFraction,
		windowLabel: limit.window?.label,
		resetsAt: limit.window?.resetsAt,
		status: limit.status,
		notes: limit.notes,
	};
}

function mapUsageReport(report: UsageReport, accountLabel?: string): RpcUsageReport {
	const metadata = report.metadata as Record<string, unknown> | undefined;
	return {
		provider: report.provider,
		fetchedAt: report.fetchedAt,
		limits: report.limits.map(mapUsageLimit),
		notes: report.notes,
		account: accountLabel ?? (metadata?.email as string | undefined) ?? (metadata?.orgName as string | undefined),
		resetCreditsAvailable: report.resetCredits?.availableCount,
	};
}

/** Build the structured usage result: provider reports + local session tallies. */
export async function buildRpcUsageResult(session: AgentSession): Promise<RpcUsageResult> {
	const reports: RpcUsageReport[] = [];
	try {
		const raw = await session.fetchUsageReports();
		if (raw && raw.length > 0) {
			const currentProvider = session.model?.provider;
			const authStorage = session.modelRegistry.authStorage;
			for (const report of raw) {
				const identity =
					report.provider === currentProvider
						? authStorage.getOAuthAccountIdentity(report.provider, session.sessionId)
						: undefined;
				const accountLabel = identity?.email ?? identity?.accountId;
				reports.push(mapUsageReport(report, accountLabel));
			}
		}
	} catch {
		// Provider usage fetch is best-effort; local stats always available.
	}

	const stats = session.sessionManager.getUsageStatistics();
	const orchestrationTokens = stats.orchestrationInput + stats.orchestrationOutput + stats.orchestrationCacheRead;
	const sessionStats: RpcUsageSessionStats = {
		input: stats.input,
		output: stats.output,
		cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite,
		totalTokens: stats.totalTokens,
		orchestrationTokens,
		premiumRequests: stats.premiumRequests,
		cost: stats.cost,
	};

	return { reports, session: sessionStats };
}

// ============================================================================
// Settings
// ============================================================================

/** Project the unified settings schema into a GUI-consumable form. */
export function buildRpcSettingsSchema(settings: Settings): RpcSettingsSchemaResult {
	const entries: RpcSettingEntry[] = [];
	const schema = SETTINGS_SCHEMA as Record<string, (typeof SETTINGS_SCHEMA)[SettingPath]>;

	for (const path of Object.keys(schema) as SettingPath[]) {
		const def = schema[path];
		const ui = "ui" in def ? (def.ui as Record<string, unknown> | undefined) : undefined;
		const secret = isCredential(path) || (ui?.secret === true);

		let options: RpcSettingEntry["options"];
		if ("values" in def && Array.isArray(def.values)) {
			options = (def.values as readonly string[]).map(v => ({ value: v, label: v }));
		}
		if (ui?.options && Array.isArray(ui.options)) {
			options = (ui.options as Array<{ value: string; label: string; description?: string }>).map(o => ({
				value: o.value,
				label: o.label,
				description: o.description,
			}));
		}

		entries.push({
			path,
			type: def.type as RpcSettingEntry["type"],
			value: settings.get(path),
			default: getDefault(path),
			label: (ui?.label as string | undefined) ?? path,
			description: ui?.description as string | undefined,
			tab: ui?.tab as string | undefined,
			group: ui?.group as string | undefined,
			options,
			secret,
			advanced: !ui,
			condition: ui?.condition as string | undefined,
			ordered: ui?.ordered === true ? true : undefined,
			tuiOnly: TUI_ONLY_SETTING_PATHS[path] === true ? true : undefined,
			restartRequired: RESTART_REQUIRED_SETTING_PATHS[path] === true ? true : undefined,
		});
	}

	const tabs = SETTING_TABS.map(tab => ({
		id: tab,
		label: TAB_METADATA[tab].label,
		groups: [...TAB_GROUPS[tab]],
	}));

	return { entries, tabs };
}

// ============================================================================
// Providers
// ============================================================================

/** Enumerate configured providers with auth state and model counts. */
export function buildRpcProvidersResult(session: AgentSession): RpcProvidersResult {
	const authStorage = session.modelRegistry.authStorage;
	const oauthProviders = getOAuthProviders();
	const oauthIds = new Set(oauthProviders.map(p => p.id));
	const oauthNameById = new Map(oauthProviders.map(p => [p.id, p.name]));

	// Count models per provider from the available catalog.
	const models = session.getAvailableModels();
	const modelCountByProvider = new Map<string, number>();
	for (const model of models) {
		modelCountByProvider.set(model.provider, (modelCountByProvider.get(model.provider) ?? 0) + 1);
	}

	// Collect all provider ids: those with models + those with OAuth + those with auth.
	const providerIds = new Set<string>([
		...modelCountByProvider.keys(),
		...oauthIds,
	]);

	// Also include providers that have stored credentials but no models yet.
	try {
		for (const cred of authStorage.listStoredCredentials()) {
			providerIds.add(cred.provider);
		}
	} catch {
		// listStoredCredentials may not be available on all store implementations.
	}

	const disabledProviders = new Set(
		(session.settings.get("disabledProviders" as SettingPath) as string[] | undefined) ?? [],
	);

	const providers: RpcProviderInfo[] = [];
	for (const id of providerIds) {
		const authenticated = authStorage.hasAuth(id);
		const identity = authenticated ? authStorage.getOAuthAccountIdentity(id, session.sessionId) : undefined;
		const isOAuth = oauthIds.has(id);

		// Determine auth kind.
		let authKind: RpcProviderInfo["authKind"];
		if (authenticated) {
			if (identity) authKind = "oauth";
			else authKind = "apikey";
		}

		providers.push({
			id,
			name: oauthNameById.get(id) ?? id,
			authenticated,
			authKind,
			account: identity?.email ?? identity?.accountId,
			oauth: isOAuth,
			disabled: disabledProviders.has(id),
			baseUrl: session.modelRegistry.getProviderBaseUrl(id),
			modelCount: modelCountByProvider.get(id) ?? 0,
		});
	}

	// Sort: authenticated first, then by model count descending.
	providers.sort((a, b) => {
		if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
		return b.modelCount - a.modelCount;
	});

	return { providers };
}
