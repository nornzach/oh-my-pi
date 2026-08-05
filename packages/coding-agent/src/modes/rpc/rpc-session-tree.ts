/**
 * Data builder for the `get_session_tree` RPC command: projects the session's
 * entry graph into a flat, GUI-consumable branch tree.
 *
 * Projection rules (agreed with the GUI SessionTreeDialog):
 * - Only `message` entries with role user/assistant/system become nodes —
 *   tool results, thinking-level changes, model changes, etc. are skipped.
 * - Each node's `parentId` is the NEAREST ANCESTOR THAT IS ITSELF INCLUDED in
 *   the tree (skipped entries are walked through), so the GUI can always draw
 *   an edge; a missing parent degrades to the synthetic root, never breaks.
 * - `textPreview` is whitespace-collapsed and pre-truncated to keep payloads
 *   small. `onActiveBranch` marks nodes on the root→active-leaf path.
 *   `label` carries the entry's resolved label, when one is set.
 */
import type { AgentSession } from "../../session/agent-session";
import type { SessionEntry } from "../../session/session-entries";
import type { RpcSessionTreeNode, RpcSessionTreeResult } from "./rpc-types";

const PREVIEW_LEN = 200;

type IncludedRole = RpcSessionTreeNode["role"];

function roleOf(entry: SessionEntry): IncludedRole | null {
	if (entry.type !== "message") return null;
	const role = entry.message.role;
	return role === "user" || role === "assistant" ? role : null;
}

function extractText(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type: "text"; text: string } =>
					typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
			)
			.map(block => block.text)
			.join(" ");
	}
	return "";
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function buildRpcSessionTree(session: AgentSession): RpcSessionTreeResult {
	const sessionManager = session.sessionManager;
	const entries = sessionManager.getEntries();
	const branch = sessionManager.getBranch();
	const branchIds = new Set(branch.map(entry => entry.id));
	const leafId = branch.at(-1)?.id ?? null;

	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const included = new Set<string>();
	for (const entry of entries) {
		if (roleOf(entry)) included.add(entry.id);
	}

	const nearestIncluded = (id: string | null): string | null => {
		let current = id;
		let guard = 0;
		while (current && guard++ < 100_000) {
			if (included.has(current)) return current;
			current = byId.get(current)?.parentId ?? null;
		}
		return null;
	};

	// Resolve each included node's parent (nearest included ancestor) and the
	// set of nodes that have at least one included child (for isLeaf).
	const parentOf = new Map<string, string | null>();
	for (const id of included) {
		parentOf.set(id, nearestIncluded(byId.get(id)?.parentId ?? null));
	}
	const hasIncludedChild = new Set<string>();
	for (const parentId of parentOf.values()) {
		if (parentId) hasIncludedChild.add(parentId);
	}

	const tree: RpcSessionTreeNode[] = [];
	for (const id of included) {
		const entry = byId.get(id);
		if (!entry || entry.type !== "message") continue;
		const role = roleOf(entry);
		if (!role) continue;
		const text = collapse(extractText(entry.message));
		const textPreview = text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN - 1)}…` : text;
		tree.push({
			entryId: id,
			parentId: parentOf.get(id) ?? null,
			role,
			textPreview,
			timestamp: Date.parse(entry.timestamp) || 0,
			label: sessionManager.getLabel(id),
			onActiveBranch: branchIds.has(id),
			isLeaf: !hasIncludedChild.has(id),
		});
	}
	tree.sort((a, b) => a.timestamp - b.timestamp);

	const activeLeafId = leafId ? nearestIncluded(leafId) : null;
	return { tree, activeLeafId };
}
