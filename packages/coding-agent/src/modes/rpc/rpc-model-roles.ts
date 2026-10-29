import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Model, modelKind } from "@oh-my-pi/pi-catalog/types";
import type { ModelBrowserRegistry } from "@oh-my-pi/pi-tui/overlays/model-browser";
import {
	formatModelSelectorValue,
	MAX_THINKING_SUFFIX_OPTIONS,
	parseModelString,
} from "@oh-my-pi/pi-tui/overlays/model-selector";
import { type ConfiguredThinkingLevel, roleThinkingLevels } from "@oh-my-pi/pi-tui/thinking";
import { getKnownRoleIds, getRoleInfo, roleCandidatePool } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import type { RpcModelRoleMetadataResult, RpcModelRoleSelection, RpcModelRolesResult } from "./rpc-types";

/** Both RPC views use canonical role discovery and configured presentation metadata. */
export function buildRpcModelRoleMetadata(settings: Settings): RpcModelRoleMetadataResult {
	return {
		roles: getKnownRoleIds(settings).map(id => {
			const { name, tag, color, hidden, section } = getRoleInfo(id, settings);
			return { id, name, tag, color, hidden, section };
		}),
	};
}

/** Do not use the session's chat-only catalog for role assignment. */
export function buildRpcModelRoles(settings: Settings, registry: ModelBrowserRegistry): RpcModelRolesResult {
	return {
		roles: buildRpcModelRoleMetadata(settings).roles.map(role => {
			const pool = roleCandidatePool(role.id, settings, registry);
			const model = settings.getModelRole(role.id);
			return {
				...role,
				model,
				selected: model ? selectedCandidate(model, pool) : undefined,
				source: settings.getModelRoleSource(role.id),
				candidates: pool.map(candidate => ({
					provider: candidate.provider,
					id: candidate.id,
					name: candidate.name,
					kind: modelKind(candidate),
					thinkingLevels: roleThinkingLevels(candidate),
				})),
			};
		}),
	};
}

/**
 * The candidate a role value names, with its `:level` suffix split off. A
 * literal id wins over the suffix split, as in `resolveModelFromString`.
 */
function selectedCandidate(value: string, pool: Model[]): RpcModelRoleSelection | undefined {
	const exact = pool.find(model => `${model.provider}/${model.id}` === value);
	if (exact) return { provider: exact.provider, id: exact.id };
	const parsed = parseModelString(value, {
		...MAX_THINKING_SUFFIX_OPTIONS,
		isLiteralModelId: (provider, id) => pool.some(model => model.provider === provider && model.id === id),
	});
	if (!parsed?.thinkingLevel) return undefined;
	const model = pool.find(candidate => candidate.provider === parsed.provider && candidate.id === parsed.id);
	return model ? { provider: model.provider, id: model.id, thinkingLevel: parsed.thinkingLevel } : undefined;
}

/**
 * Role value `set_model_role` persists: `modelId` with `thinkingLevel` as its
 * `:level` suffix. A level is accepted only for a role candidate that offers
 * it, so a role never stores a level its model cannot apply.
 */
export function rpcModelRoleValue(
	role: string,
	modelId: string | null,
	thinkingLevel: ConfiguredThinkingLevel | undefined,
	settings: Settings,
	registry: ModelBrowserRegistry,
): string | undefined {
	if (modelId === null) return undefined;
	if (thinkingLevel === undefined || thinkingLevel === ThinkingLevel.Inherit) return modelId;
	const model = roleCandidatePool(role, settings, registry).find(
		candidate => `${candidate.provider}/${candidate.id}` === modelId,
	);
	if (!model) throw new Error(`${modelId} is not a model the ${role} role accepts`);
	if (!roleThinkingLevels(model).includes(thinkingLevel)) {
		throw new Error(`${modelId} does not support thinking level ${thinkingLevel}`);
	}
	return formatModelSelectorValue(modelId, thinkingLevel);
}
