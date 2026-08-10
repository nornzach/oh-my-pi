import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import {
	deleteManagedSkill,
	MANAGED_SKILLS_PROVIDER_ID,
	sanitizeSkillName,
	writeManagedSkill,
} from "../../autolearn/managed-skills";
import type { AgentSession } from "../../session/agent-session";
import { buildRpcSkillsResult } from "./rpc-domains";
import type { RpcManageSkillResult, RpcSkillDetail } from "./rpc-types";

const MAX_SKILL_DETAIL_BYTES = 256_000;

async function findSkill(session: AgentSession, rawName: string) {
	const name = rawName.trim();
	if (!name) throw new Error("Skill name cannot be empty.");
	const result = await buildRpcSkillsResult(session);
	const skill = result.skills.find(candidate => candidate.name === name);
	if (!skill) throw new Error(`Skill "${name}" not found.`);
	return skill;
}

/** Read a discovered skill by name so renderer callers can never supply an arbitrary path. */
export async function buildRpcSkillDetail(session: AgentSession, name: string): Promise<RpcSkillDetail> {
	const skill = await findSkill(session, name);
	const file = Bun.file(skill.location);
	if (file.size > MAX_SKILL_DETAIL_BYTES) {
		throw new Error(`Skill "${skill.name}" is too large to preview (${file.size} bytes).`);
	}
	const content = await file.text();
	if (Buffer.byteLength(content, "utf8") > MAX_SKILL_DETAIL_BYTES) {
		throw new Error(`Skill "${skill.name}" is too large to preview.`);
	}
	const { body } = parseFrontmatter(content, { source: skill.location });
	return { ...skill, body: body.trim() };
}

/**
 * Create/update/delete only the isolated omp-managed provider. Authored and
 * plugin-provided skills are intentionally read-only through this RPC.
 */
export async function applyRpcManageSkill(
	session: AgentSession,
	action: "create" | "update" | "delete",
	rawName: string,
	description?: string,
	body?: string,
): Promise<RpcManageSkillResult> {
	const name = sanitizeSkillName(rawName);
	if (action === "create") {
		const discovered = await buildRpcSkillsResult(session);
		if (discovered.skills.some(skill => skill.name === name)) {
			throw new Error(`Skill "${name}" already exists. Choose a different name.`);
		}
		await writeManagedSkill({ action, name, description: description ?? "", body: body ?? "" });
		return { action, name };
	}

	const existing = await findSkill(session, name);
	if (!existing.managed || existing.provider !== MANAGED_SKILLS_PROVIDER_ID) {
		throw new Error(`Skill "${name}" is managed by ${existing.providerName} and is read-only here.`);
	}
	if (action === "delete") {
		await deleteManagedSkill(name);
	} else {
		await writeManagedSkill({ action, name, description: description ?? "", body: body ?? "" });
	}
	return { action, name };
}
