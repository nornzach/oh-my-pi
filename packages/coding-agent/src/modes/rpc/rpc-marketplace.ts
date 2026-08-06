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
import { classifySource } from "../../extensibility/plugins/marketplace";
import type { AgentSession } from "../../session/agent-session";
import { createDomainMarketplaceManager } from "./rpc-domains";
import type { RpcMarketplaceActionResult, RpcMarketplacePluginInfo } from "./rpc-types";

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
				await manager.installPlugin(command.plugin, command.marketplace);
				return { ok: true };
			}
			case "uninstall": {
				await manager.uninstallPlugin(resolvePluginId(command.plugin, command.marketplace));
				return { ok: true };
			}
			case "upgrade": {
				await manager.upgradePlugin(resolvePluginId(command.plugin, command.marketplace));
				return { ok: true };
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
