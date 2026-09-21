import { modelKind } from "@oh-my-pi/pi-catalog/types";
import type { ModelBrowserRegistry } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { getKnownRoleIds, getRoleInfo, roleCandidatePool } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import type { RpcModelRoleMetadataResult, RpcModelRolesResult } from "./rpc-types";

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
		roles: buildRpcModelRoleMetadata(settings).roles.map(role => ({
			...role,
			model: settings.getModelRole(role.id),
			source: settings.getModelRoleSource(role.id),
			candidates: roleCandidatePool(role.id, settings, registry).map(model => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				kind: modelKind(model),
			})),
		})),
	};
}
