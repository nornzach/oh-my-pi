/**
 * C1 plugin detail and settings for RPC mode: `get_plugin_detail`,
 * `set_plugin_features`, `set_plugin_setting`, `delete_plugin_setting`.
 *
 * Backed by `PluginManager` (the npm install channel owns runtime
 * settings/features in the plugin lockfile — the same backing the TUI plugin
 * settings UI edits). Detail composes three existing reads (no single backing
 * method): the `list()` manifest, `getPluginSettings`, and
 * `getEnabledFeatures`. All mutations go through PluginManager methods (its
 * in-memory config cache stays coherent; callers NEVER touch
 * omp-plugins.lock.json directly) and every mutation's caller (rpc-mode.ts)
 * ends in `reloadPluginState()`.
 *
 * Domain failures (unknown plugin/setting, schema violations) resolve
 * `{ ok:false, error }` from the mutating helpers; `get_plugin_detail` throws
 * (its result shape has no error channel).
 */
import * as path from "node:path";
import { pathIsWithin } from "@oh-my-pi/pi-utils";
import { clearPluginRootsAndCaches } from "../../discovery/helpers";
import { getEnabledPlugins } from "../../extensibility/plugins/loader";
import { PluginManager, validateSetting } from "../../extensibility/plugins/manager";
import { parsePluginId } from "../../extensibility/plugins/marketplace";
import type { InstalledPlugin, PluginManifest } from "../../extensibility/plugins/types";
import type { AgentSession } from "../../session/agent-session";
import { createDomainMarketplaceManager } from "./rpc-domains";
import { capturePluginActivationState, classifyPluginActivation } from "./rpc-marketplace";
import type { RpcGuiThemeInfo, RpcGuiThemesResult, RpcPluginDetail, RpcPluginMutationResult } from "./rpc-types";
/**
 * Collect declarative GUI theme tokens from the plugins the runtime would
 * actually load for this cwd. Raw tokens cross the wire; the GUI owns the
 * token allowlist and value validation. Unreadable, malformed, and escaping
 * assets skip only their plugin.
 */
export async function buildRpcGuiThemes(session: AgentSession): Promise<RpcGuiThemesResult> {
	const themes: RpcGuiThemeInfo[] = [];
	for (const plugin of await getEnabledPlugins(session.sessionManager.getCwd())) {
		const themePath = plugin.manifest.gui?.theme;
		if (typeof themePath !== "string" || themePath.length === 0) continue;
		const resolved = path.resolve(plugin.path, themePath);
		if (!pathIsWithin(plugin.path, resolved)) continue;
		try {
			const parsed = (await Bun.file(resolved).json()) as Record<string, unknown>;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			themes.push({
				id: plugin.name,
				tokens: Object.fromEntries(
					Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				),
			});
		} catch {
			// A plugin theme is optional; its failure must not break inventory.
		}
	}
	return { themes };
}

/** A `name@marketplace` id addresses its package by bare name; npm ids pass through. */
function pluginNameFromId(pluginId: string): string {
	return parsePluginId(pluginId)?.name ?? pluginId;
}

async function findRpcPlugin(
	manager: PluginManager,
	pluginId: string,
	cwd: string,
): Promise<InstalledPlugin | undefined> {
	if (!pluginId.trim()) return undefined;
	const name = pluginNameFromId(pluginId);
	const plugins = await manager.list();
	const npmPlugin = plugins.find(plugin => plugin.name === pluginId) ?? plugins.find(plugin => plugin.name === name);
	if (npmPlugin) return npmPlugin;

	// PluginManager intentionally omits marketplace-created runtime symlinks
	// from list() to avoid duplicate inventory rows. Resolve those rows from
	// the installed registry and their cached package manifest instead.
	const marketplace = await createDomainMarketplaceManager(cwd);
	const summary = (await marketplace.listInstalledPlugins()).find(candidate => candidate.id === pluginId);
	const entry = summary?.entries[0];
	if (!entry) return undefined;
	const pkg = (await Bun.file(`${entry.installPath}/package.json`).json()) as {
		name?: string;
		version?: string;
		omp?: PluginManifest;
		pi?: PluginManifest;
	};
	const manifest = pkg.omp ?? pkg.pi;
	if (!manifest) return undefined;
	const packageName = pkg.name?.trim() || name;
	const effective = (await getEnabledPlugins(cwd)).find(
		plugin => plugin.path === entry.installPath || plugin.name === packageName,
	);
	if (effective) return effective;
	return {
		name: packageName,
		version: pkg.version ?? entry.version,
		path: entry.installPath,
		manifest: { ...manifest, version: pkg.version ?? entry.version },
		enabledFeatures: await manager.getEnabledFeatures(packageName),
		enabled: entry.enabled !== false,
	};
}

const MASKED_SETTING_KEY_RE = /key|token|secret|password/i;

function isSecretSetting(key: string, schema: { secret?: boolean } | undefined): boolean {
	return schema?.secret === true || MASKED_SETTING_KEY_RE.test(key);
}

function redactPluginSettingsSchema(
	settings: NonNullable<InstalledPlugin["manifest"]["settings"]>,
): NonNullable<InstalledPlugin["manifest"]["settings"]> {
	return Object.fromEntries(
		Object.entries(settings).map(([key, setting]) => {
			if (!isSecretSetting(key, setting)) return [key, setting];
			const sanitized = { ...setting };
			delete sanitized.default;
			return [key, sanitized];
		}),
	);
}

/**
 * Compose the full detail for one plugin: manifest-declared features with
 * live enable state (null enabledFeatures = manifest defaults), the declared
 * settings schema, and effective non-secret setting values (project overrides
 * merged over user). Secret values are represented only by their key in
 * `configuredKeys`; raw credentials never cross the RPC boundary.
 */
export async function buildRpcPluginDetail(session: AgentSession, pluginId: string): Promise<RpcPluginDetail> {
	const manager = new PluginManager(session.sessionManager.getCwd());
	const plugin = await findRpcPlugin(manager, pluginId, session.sessionManager.getCwd());
	if (!plugin) {
		throw new Error(`Plugin "${pluginId}" not found.`);
	}
	const enabledFeatures = plugin.enabledFeatures;
	const enabledSet = enabledFeatures === null ? null : new Set(enabledFeatures);
	const features = Object.entries(plugin.manifest.features ?? {}).map(([id, feature]) => ({
		id,
		...(feature.description !== undefined ? { description: feature.description } : {}),
		enabled: enabledSet ? enabledSet.has(id) : feature.default === true,
	}));
	const configuredValues = await manager.getPluginSettings(plugin.name);
	const values = Object.fromEntries(
		Object.entries(configuredValues).filter(([key]) => !isSecretSetting(key, plugin.manifest.settings?.[key])),
	);
	return {
		id: plugin.name,
		enabled: plugin.enabled,
		features,
		...(plugin.manifest.settings !== undefined
			? { settingsSchema: redactPluginSettingsSchema(plugin.manifest.settings) }
			: {}),
		values,
		configuredKeys: Object.keys(configuredValues),
	};
}

/** Enable a specific feature set (`setEnabledFeatures` validates unknown features). */
export async function applyRpcSetPluginFeatures(
	session: AgentSession,
	pluginId: string,
	features: string[],
): Promise<RpcPluginMutationResult> {
	try {
		const cwd = session.sessionManager.getCwd();
		const manager = new PluginManager(cwd);
		const plugin = await findRpcPlugin(manager, pluginId, cwd);
		if (!plugin) return { ok: false, error: `Plugin "${pluginId}" not found.` };
		const before = await capturePluginActivationState(cwd);
		await manager.setEnabledFeatures(plugin.name, features, {
			version: plugin.version,
			manifest: plugin.manifest,
		});
		clearPluginRootsAndCaches();
		const after = await capturePluginActivationState(cwd);
		return { ok: true, activation: classifyPluginActivation(before, after) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Set one plugin setting with manifest-schema validation: unknown keys (when
 * the plugin declares a schema) and `validateSetting` failures ride the
 * result's `error` field.
 */
export async function applyRpcSetPluginSetting(
	session: AgentSession,
	pluginId: string,
	key: string,
	value: unknown,
): Promise<RpcPluginMutationResult> {
	try {
		if (!key.trim()) return { ok: false, error: "Setting key cannot be empty" };
		const manager = new PluginManager(session.sessionManager.getCwd());
		const plugin = await findRpcPlugin(manager, pluginId, session.sessionManager.getCwd());
		if (!plugin) return { ok: false, error: `Plugin "${pluginId}" not found.` };
		const schema = plugin.manifest.settings?.[key];
		if (plugin.manifest.settings !== undefined && !schema) {
			return {
				ok: false,
				error: `Unknown setting "${key}" for plugin "${plugin.name}". Available: ${Object.keys(plugin.manifest.settings).join(", ")}`,
			};
		}
		if (schema) {
			const validation = validateSetting(value, schema);
			if (!validation.valid) {
				return { ok: false, error: `Invalid value for "${key}": ${validation.error ?? "schema mismatch"}` };
			}
		}
		await manager.setPluginSetting(plugin.name, key, value);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Delete one plugin setting (no-op when the key was never set). */
export async function applyRpcDeletePluginSetting(
	session: AgentSession,
	pluginId: string,
	key: string,
): Promise<RpcPluginMutationResult> {
	try {
		if (!key.trim()) return { ok: false, error: "Setting key cannot be empty" };
		const manager = new PluginManager(session.sessionManager.getCwd());
		const plugin = await findRpcPlugin(manager, pluginId, session.sessionManager.getCwd());
		if (!plugin) return { ok: false, error: `Plugin "${pluginId}" not found.` };
		await manager.deletePluginSetting(plugin.name, key);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
