/**
 * Data builders for extension-feature RPC commands (usage, settings, providers).
 * Keeps rpc-mode.ts switch cases thin; all projection logic lives here.
 */

import { resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { Settings } from "../../config/settings";
import { orderedSettings } from "../../config/all-settings";
import { lookup as lookupSetting } from "../../config/registry";
import { SETTING_TABS, TAB_GROUPS, TAB_METADATA } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import type { AgentSession } from "../../session/agent-session";
import type {
	RpcProviderInfo,
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
						? authStorage.oauth.identity(report.provider, session.sessionId)
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

/** Project the registry into a GUI-consumable settings schema. */
export function buildRpcSettingsSchema(settings: Settings): RpcSettingsSchemaResult {
	const entries: RpcSettingEntry[] = [];

	for (const setting of orderedSettings()) {
		const ui = setting.ui;
		let options: RpcSettingEntry["options"];
		if (setting.enumValues) options = setting.enumValues.map(value => ({ value, label: value }));
		if (ui?.options && Array.isArray(ui.options)) {
			options = ui.options.map(option => ({
				value: option.value,
				label: option.label,
				description: option.description,
			}));
		}

		entries.push({
			path: setting.id,
			type: setting.type as RpcSettingEntry["type"],
			value: setting.get(settings),
			provenance: settings.getProvenanceDetails(setting),
			default: setting.default,
			label: ui?.label ?? setting.id,
			description: ui?.description,
			tab: ui?.tab,
			group: ui?.group,
			options,
			secret: setting.isCredential,
			advanced: !ui,
			condition: ui?.condition,
			ordered: ui?.ordered === true ? true : undefined,
			tuiOnly: setting.tuiOnly ? true : undefined,
			restartRequired: setting.restartRequired ? true : undefined,
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
export function buildRpcProvidersResult(session: AgentSession): { providers: RpcProviderInfo[] } {
	const authStorage = session.modelRegistry.authStorage;
	const loginProviders = getOAuthProviders();
	const loginIds = new Set(loginProviders.map(provider => provider.id));
	const loginNameById = new Map(loginProviders.map(provider => [provider.id, provider.name]));

	// Count models per provider from the available catalog.
	const models = session.getAvailableModels();
	const modelCountByProvider = new Map<string, number>();
	for (const model of models) {
		modelCountByProvider.set(model.provider, (modelCountByProvider.get(model.provider) ?? 0) + 1);
	}

	// Collect all provider ids: those with models + registered login flows + those with auth.
	const providerIds = new Set<string>([...modelCountByProvider.keys(), ...loginIds]);

	// Also include providers that have stored credentials but no models yet.
	try {
		for (const cred of authStorage.credentials.list()) {
			providerIds.add(cred.provider);
		}
	} catch {
		// listStoredCredentials may not be available on all store implementations.
	}

	const disabledProvidersSetting = lookupSetting("disabledProviders");
	const disabledProviders = new Set(
		(disabledProvidersSetting?.get(session.settings) as string[] | undefined) ?? [],
	);

	const providers: RpcProviderInfo[] = [];
	for (const id of providerIds) {
		const authenticated = authStorage.keys.source(id) !== undefined;
		const identity = authenticated ? authStorage.oauth.identity(id, session.sessionId) : undefined;
		const loginAvailable = loginIds.has(id);

		// Determine auth kind.
		let authKind: RpcProviderInfo["authKind"];
		if (authenticated) {
			if (identity) authKind = "oauth";
			else authKind = "apikey";
		}

		providers.push({
			id,
			name: loginNameById.get(id) ?? id,
			authenticated,
			authKind,
			account: identity?.email ?? identity?.accountId,
			loginAvailable,
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

/** Validate the public RPC boundary before a malformed value can reach persistent settings. */
export function validateRpcSettingValue(path: string, value: unknown): void {
	const setting = lookupSetting(path);
	if (!setting) throw new Error(`Unknown setting path: ${path}`);
	setting.assertWritable(value);
}
