/**
 * RPC builders for the native GUI report dialogs: structured counterparts of
 * the TUI /context, /tools, /share, /jobs outputs. Each builder reads the
 * same session data source as its slash-command twin (see builtin-registry);
 * all formatting stays client-side.
 */
import {
	buildShareSnapshot,
	normalizeShareServerUrl,
	type ShareSessionOptions,
	shareSnapshot,
	fitShareSnapshot,
} from "../../export/share";
import type { AgentSession } from "../../session/agent-session";
import { isMCPToolName } from "../../tools/builtin-names";
import type {
	RpcActiveTool,
	RpcActiveToolsResult,
	RpcContextReportResult,
	RpcJobsResult,
	RpcShareSessionResult,
	RpcShareSessionPreview,
	RpcToolSource,
} from "./rpc-types";

/**
 * `/context` parity: the provider-anchored breakdown verbatim, plus the
 * window/model header. When no model is selected the breakdown falls back to
 * a zero window — the TUI's "unavailable" state.
 */
export function buildRpcContextReport(session: AgentSession): RpcContextReportResult {
	const breakdown = session.getContextBreakdown();
	return {
		breakdown,
		contextWindow: breakdown?.contextWindow ?? session.model?.contextWindow ?? 0,
		model: session.model?.id ?? "",
	};
}

/**
 * Tool provenance mirrors the registry's own distinctions: MCP tools carry
 * the `mcp__` wire prefix, first-party factories are tracked by the session,
 * and everything else arrived through the extension/custom-tool path
 * (plugin-shipped tools included — their provenance is not retained once
 * loaded, so they surface as `extension`).
 */
function classifyToolSource(session: AgentSession, name: string): RpcToolSource {
	if (isMCPToolName(name)) return "mcp";
	if (session.hasBuiltInTool(name)) return "builtin";
	return "extension";
}

/**
 * `/tools` parity (command-controller's handleToolsCommand): active
 * top-level tools with their descriptions, then xd:// mounted entries with
 * their prompt summaries. Both resolve source through the canonical registry.
 */
export function buildRpcActiveTools(session: AgentSession): RpcActiveToolsResult {
	const tools: RpcActiveTool[] = session.agent.state.tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		source: classifyToolSource(session, tool.name),
	}));
	for (const mounted of session.getXdevToolEntries()) {
		tools.push({
			name: mounted.name,
			description: mounted.summary,
			source: classifyToolSource(session, mounted.name),
		});
	}
	return { tools };
}

function shareOptions(session: AgentSession): ShareSessionOptions {
	return {
		serverUrl: session.settings.get("share.serverUrl"),
		store: session.settings.get("share.store"),
		state: session.state,
		obfuscator: session.settings.get("share.redactSecrets") ? session.obfuscator : undefined,
	};
}

/** Local-only preview. The digest binds the entire snapshot and upload destination. */
export function previewRpcShareSession(session: AgentSession): RpcShareSessionPreview {
	const options = shareOptions(session);
	const fitted = fitShareSnapshot(buildShareSnapshot(session.sessionManager, options), options.store);
	const preview = JSON.stringify(fitted.data, null, 2);
	const serverUrl = normalizeShareServerUrl(options.serverUrl);
	const store = options.store ?? "blob";
	const redactionEnabled = session.settings.get("share.redactSecrets") === true;
	const snapshotId = new Bun.CryptoHasher("sha256")
		.update(JSON.stringify({ preview, serverUrl, store, redactionEnabled }))
		.digest("hex");
	return { snapshotId, preview, serverUrl, store, redactionEnabled, truncated: fitted.truncated };
}

/** Legacy RPC callers may omit snapshotId; GUI always confirms a local preview first. */
export async function shareRpcSession(session: AgentSession, snapshotId?: string): Promise<RpcShareSessionResult> {
	const prepared = previewRpcShareSession(session);
	if (snapshotId !== undefined && snapshotId !== prepared.snapshotId) {
		throw new Error("Session or sharing settings changed. Refresh the local preview before uploading.");
	}
	// Upload these exact bytes' data, without retaining drafts on the Agent.
	const result = await shareSnapshot(JSON.parse(prepared.preview), {
		...shareOptions(session),
		confirmedPreview: snapshotId !== undefined,
	});
	return result.truncated || prepared.truncated ? { url: result.url, truncated: true } : { url: result.url };
}

/**
 * `/jobs` parity: running jobs first, then recent (same snapshot the slash
 * command reads). A null snapshot means the session has no async-job
 * registry; the dialog renders that as its empty state.
 */
export function buildRpcJobs(session: AgentSession): RpcJobsResult {
	const snapshot = session.getAsyncJobSnapshot({ recentLimit: 5, includeResults: true });
	if (!snapshot) return { jobs: [] };
	return { jobs: [...snapshot.running, ...snapshot.recent] };
}
