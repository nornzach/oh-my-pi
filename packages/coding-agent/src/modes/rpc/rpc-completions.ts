/**
 * `get_command_arg_completions` RPC action: dynamic slash-command argument
 * candidates for remote composers (TUI prompt-action-autocomplete parity).
 *
 * Static subcommand completion reuses the shared completion builders verbatim. The
 * MCP server-name path re-implements collectMcpServerNames locally — the TUI
 * collector takes InteractiveModeContext, which RPC mode does not have; the
 * underlying data (user/project mcp config + the process-global MCPManager)
 * is directly readable. Extension/custom commands carry no argument metadata
 * and return no candidates.
 */

import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { readMCPConfigFile } from "../../mcp/config-writer";
import { MCPManager } from "../../mcp/manager";
import type { MCPConfigFile } from "../../mcp/types";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildMcpRemoveCompletions,
	MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS,
	MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS,
	MCP_SERVER_NAME_SUBCOMMANDS,
} from "../../slash-commands/builtin-completions";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../../slash-commands/builtin-registry";

export interface RpcArgCompletionItem {
	value: string;
	label?: string;
	description?: string;
	hint?: string;
}

/** Local stand-in for collectMcpServerNames (mcp-command-controller.ts:276) — same sources, no InteractiveModeContext. */
async function collectRpcMcpServerNames(
	cwd: string,
	includeDisabledOnly: boolean,
	includeDisabledConfigured: boolean,
): Promise<string[]> {
	const [userConfig, projectConfig] = await Promise.all([
		readMCPConfigFile(getMCPConfigPath("user", cwd)),
		readMCPConfigFile(getMCPConfigPath("project", cwd)),
	]);
	const names = new Set<string>(includeDisabledOnly ? (userConfig.disabledServers ?? []) : []);
	const addConfiguredNames = (config: MCPConfigFile): void => {
		for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
			if (server && (includeDisabledConfigured || server.enabled !== false)) names.add(name);
		}
	};
	addConfiguredNames(userConfig);
	addConfiguredNames(projectConfig);
	for (const name of MCPManager.instance()?.getAllServerNames() ?? []) names.add(name);
	return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export async function buildRpcCommandArgCompletions(
	cwd: string,
	commandName: string,
	prefix: string,
): Promise<RpcArgCompletionItem[] | null> {
	const spec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(
		command => command.name === commandName || command.aliases?.includes(commandName),
	);
	if (!spec) return null;

	if (spec.subcommands) {
		// /mcp switches from subcommand completion to server-name completion
		// once a recognized server-name subcommand is followed by a space
		// (buildMcpArgumentCompletions parity).
		if (spec.name === "mcp") {
			const spaceIndex = prefix.indexOf(" ");
			if (spaceIndex === -1) return buildArgumentCompletions(spec.subcommands)(prefix);
			const rawSubcommand = prefix.slice(0, spaceIndex);
			const lowerSubcommand = rawSubcommand.toLowerCase();
			if (MCP_SERVER_NAME_SUBCOMMANDS[lowerSubcommand] !== true) return null;
			const namePrefix = prefix.slice(spaceIndex + 1).toLowerCase();
			if (lowerSubcommand === "remove") {
				// Session cwd, not the process-global project dir: RPC sessions can
				// run with a cwd different from where the server was launched.
				return await buildMcpRemoveCompletions(rawSubcommand, namePrefix, cwd);
			}
			let serverNames: string[];
			try {
				serverNames = await collectRpcMcpServerNames(
					cwd,
					MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
					MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
				);
			} catch {
				return null;
			}
			const matches = serverNames
				.filter(name => name.toLowerCase().startsWith(namePrefix))
				.map(name => ({ value: `${rawSubcommand} ${name} `, label: name }));
			return matches.length > 0 ? matches : null;
		}
		return buildArgumentCompletions(spec.subcommands)(prefix);
	}

	if (spec.name === "move") {
		return await buildDirectoryArgumentCompletions()(prefix);
	}
	return null;
}
