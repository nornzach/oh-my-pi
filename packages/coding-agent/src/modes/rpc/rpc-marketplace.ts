/**
 * C1 marketplace management for RPC mode: `marketplace_action`. Thin wrapper
 * over `MarketplaceManager` (constructed via the rpc-domains
 * `createDomainMarketplaceManager` mirror), mirroring the `/marketplace`
 * slash-command mutations. Domain failures (unknown marketplace/plugin,
 * invalid source, install errors) resolve `{ ok:false, error }` rather than
 * throwing — the result shape carries an error channel.
 *
 * Every mutation's caller (rpc-mode.ts) ends in `reloadPluginState()` so the
 * GUI receives a fresh `available_commands_update`.
 */
import { getEnabledPlugins, type ScopedInstalledPlugin } from "../../extensibility/plugins/loader";
import { classifySource } from "../../extensibility/plugins/marketplace";
import type { PluginManifest } from "../../extensibility/plugins/types";
import type { AgentSession } from "../../session/agent-session";
import { createDomainMarketplaceManager } from "./rpc-domains";
import type { RpcMarketplaceActionResult, RpcMarketplacePluginInfo, RpcPluginActivation } from "./rpc-types";

export type RpcMarketplaceAction = "add" | "remove" | "update" | "install" | "uninstall" | "upgrade" | "list_available";

/**
 * Compose the canonical `name@marketplace` plugin id the manager mutations
 * address. Accepts a fully qualified id verbatim; a bare name requires the
 * command's `marketplace` field.
 */
function resolvePluginId(plugin: string | undefined, marketplace: string | undefined): string {
	if (!plugin?.trim()) throw new Error("Missing `plugin` for this marketplace action.");
	if (plugin.includes("@")) return plugin;
	if (!marketplace?.trim()) {
		throw new Error(`Plugin "${plugin}" is not qualified; pass \`marketplace\` or a "name@marketplace" id.`);
	}
	return `${plugin}@${marketplace}`;
}

/**
 * Whether a manifest ships executable entry points — extensions/tools/hooks on
 * the base manifest or on features that would load (explicit selection, or
 * manifest defaults when the selection is null). Extension factories bind only
 * at session creation, so mutations touching these need a sidecar restart;
 * commands and skills hot-reload through reloadPluginState.
 */
export function pluginRequiresRestart(manifest: PluginManifest, enabledFeatures: string[] | null): boolean {
	for (const key of ["extensions", "tools", "hooks"] as const) {
		const base = manifest[key];
		if (Array.isArray(base) ? base.length > 0 : Boolean(base)) return true;
		for (const [name, feature] of Object.entries(manifest.features ?? {})) {
			const on = enabledFeatures === null ? feature.default === true : enabledFeatures.includes(name);
			const entries = feature[key];
			if (on && entries !== undefined && entries.length > 0) return true;
		}
	}
	return false;
}

/** Snapshot the plugins the runtime would actually load for this cwd. */
export async function capturePluginActivationState(cwd: string): Promise<ScopedInstalledPlugin[]> {
	return await getEnabledPlugins(cwd);
}

function sameFeatures(left: string[] | null, right: string[] | null): boolean {
	if (left === null || right === null) return left === right;
	if (left.length !== right.length) return false;
	const rightSet = new Set(right);
	return left.every(feature => rightSet.has(feature));
}

/**
 * Classify a completed mutation from the effective runtime state on each side.
 * This covers executable additions and removals, feature changes, upgrades,
 * and project/user shadow switches without guessing from one registry entry.
 */
export function classifyPluginActivation(
	before: readonly ScopedInstalledPlugin[],
	after: readonly ScopedInstalledPlugin[],
): RpcPluginActivation {
	const beforeByName = new Map(before.map(plugin => [plugin.name, plugin]));
	const afterByName = new Map(after.map(plugin => [plugin.name, plugin]));
	for (const name of new Set([...beforeByName.keys(), ...afterByName.keys()])) {
		const previous = beforeByName.get(name);
		const next = afterByName.get(name);
		if (
			previous &&
			next &&
			previous.path === next.path &&
			previous.version === next.version &&
			sameFeatures(previous.enabledFeatures, next.enabledFeatures)
		) {
			continue;
		}
		if (
			(previous && pluginRequiresRestart(previous.manifest, previous.enabledFeatures)) ||
			(next && pluginRequiresRestart(next.manifest, next.enabledFeatures))
		) {
			return "restart-required";
		}
	}
	return "live";
}

/**
 * Run one marketplace action. Never throws for domain failures — they resolve
 * `{ ok:false, error }`; only truly unexpected errors propagate.
 */
export async function applyRpcMarketplaceAction(
	session: AgentSession,
	command: { action: RpcMarketplaceAction; marketplace?: string; plugin?: string; source?: string },
): Promise<RpcMarketplaceActionResult> {
	try {
		// Validate the source form BEFORE building the manager (which probes the
		// fs): classifySource rejects bare names with guidance
		// ("Did you mean './x' (local) or 'owner/repo' (GitHub)?").
		if (command.action === "add") {
			if (!command.source?.trim()) return { ok: false, error: "Missing `source` for marketplace add." };
			classifySource(command.source);
		}

		const manager = await createDomainMarketplaceManager(session.sessionManager.getCwd());
		const cwd = session.sessionManager.getCwd();

		switch (command.action) {
			case "add": {
				await manager.addMarketplace(command.source!);
				return { ok: true };
			}
			case "remove": {
				if (!command.marketplace?.trim()) return { ok: false, error: "Missing `marketplace` for remove." };
				await manager.removeMarketplace(command.marketplace);
				return { ok: true };
			}
			case "update": {
				// `update` refreshes the cache-backed catalog(s); without a name it
				// refreshes every configured marketplace (`/marketplace update` parity).
				if (command.marketplace?.trim()) {
					await manager.updateMarketplace(command.marketplace);
				} else {
					await manager.updateAllMarketplaces();
				}
				return { ok: true };
			}
			case "install": {
				if (!command.plugin?.trim()) return { ok: false, error: "Missing `plugin` for install." };
				if (!command.marketplace?.trim()) return { ok: false, error: "Missing `marketplace` for install." };
				const before = await capturePluginActivationState(cwd);
				await manager.installPlugin(command.plugin, command.marketplace);
				const after = await capturePluginActivationState(cwd);
				return { ok: true, activation: classifyPluginActivation(before, after) };
			}
			case "uninstall": {
				const before = await capturePluginActivationState(cwd);
				await manager.uninstallPlugin(resolvePluginId(command.plugin, command.marketplace));
				const after = await capturePluginActivationState(cwd);
				return { ok: true, activation: classifyPluginActivation(before, after) };
			}
			case "upgrade": {
				const before = await capturePluginActivationState(cwd);
				await manager.upgradePlugin(resolvePluginId(command.plugin, command.marketplace));
				const after = await capturePluginActivationState(cwd);
				return { ok: true, activation: classifyPluginActivation(before, after) };
			}
			case "list_available": {
				// Catalogs are cache-backed (populated by add/update), so the
				// listing reflects the last fetch — the wire shape has no
				// freshness field to report that on.
				const installedIds = new Set((await manager.listInstalledPlugins()).map(summary => summary.id));
				const marketplaces = await manager.listMarketplaces();
				if (command.marketplace && !marketplaces.some(entry => entry.name === command.marketplace)) {
					return { ok: false, error: `Marketplace "${command.marketplace}" not found` };
				}
				const plugins: RpcMarketplacePluginInfo[] = [];
				for (const entry of marketplaces) {
					if (command.marketplace && entry.name !== command.marketplace) continue;
					for (const plugin of await manager.listAvailablePlugins(entry.name)) {
						plugins.push({
							name: plugin.name,
							...(plugin.description !== undefined ? { description: plugin.description } : {}),
							...(plugin.version !== undefined ? { version: plugin.version } : {}),
							installed: installedIds.has(`${plugin.name}@${entry.name}`),
							...(plugin.author?.name ? { author: plugin.author.name } : {}),
							...(plugin.license !== undefined ? { license: plugin.license } : {}),
							...(plugin.repository !== undefined ? { repository: plugin.repository } : {}),
							...(plugin.homepage !== undefined ? { homepage: plugin.homepage } : {}),
							...(plugin.category !== undefined ? { category: plugin.category } : {}),
							...(plugin.tags !== undefined && plugin.tags.length > 0 ? { tags: plugin.tags } : {}),
						});
					}
				}
				return { ok: true, plugins };
			}
			default:
				// Wire frames are cast, not shape-validated — an action outside
				// the declared union resolves an error instead of undefined.
				return { ok: false, error: `Unknown marketplace action: ${command.action}` };
		}
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
