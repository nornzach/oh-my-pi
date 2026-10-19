/**
 * The `/advisor configure` WATCHDOG.yml editor, shared by the TUI (an overlay
 * on its own screen) and RPC hosts (a hosted terminal view).
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TUI } from "@oh-my-pi/pi-tui";
import {
	type AdvisorConfigDeps,
	AdvisorConfigOverlayComponent,
	type AdvisorConfigScope,
} from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { collapseSharedUsageReports } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { sanitizeDisplayWarnings } from "@oh-my-pi/pi-tui/render/render-utils";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import {
	ADVISOR_DEFAULT_TOOL_NAMES,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
} from "../advisor";
import { cfgAdvisorSyncBacklog } from "../advisor/settings";
import { resolveAdvisorRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { limitMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";
import { getEditorCommand, openInEditor } from "../utils/external-editor";
import { createModelBrowserSource } from "./model-browser-source";

/** Where the editor reports, and what it repaints, in the hosting UI. */
export interface AdvisorConfigOverlayHost {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	status(message: string): void;
	warn(message: string): void;
	/** The live advisor roster changed (a status line advisor badge must repaint). */
	advisorsChanged(): void;
	requestRender(): void;
}

/** Load the project WATCHDOG.yml and build its editor; `close` runs when the user leaves it. */
export async function createAdvisorConfigOverlay(
	ui: TUI,
	host: AdvisorConfigOverlayHost,
	close: () => void,
): Promise<AdvisorConfigOverlayComponent> {
	const { session, settings, cwd } = host;
	const agentDir = getAgentDir() ?? getProjectDir();
	const initialScope: AdvisorConfigScope = "project";
	// "Project" scope edits the repo-root WATCHDOG.yml (the project-level file
	// discovery walks), not the launch subdir — `getProjectDir()` is only cwd.
	let projectDir = cwd;
	try {
		projectDir = vcs.repo(cwd)?.root() ?? cwd;
	} catch {
		projectDir = cwd;
	}
	const dirs = { projectDir, agentDir };
	const initialDoc = await loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(initialScope, dirs));
	if (initialDoc.warnings?.length) {
		host.warn(`WATCHDOG.yml: ${sanitizeDisplayWarnings(initialDoc.warnings).join("; ")}`);
	}
	// Label the seeded implicit-default row with the actual advisor-role model
	// (NOT the first live advisor, which may be a named advisor from another scope).
	const defaultAdvisorModel = resolveAdvisorRoleSelection(settings, session.modelRegistry.getAvailable())?.model;
	const deps: AdvisorConfigDeps = {
		getAvailableModels: () => session.modelRegistry.getAvailable(),
		browserSource: createModelBrowserSource(settings, model => session.effectiveServiceTier(model)),
		defaultToolNames: ADVISOR_DEFAULT_TOOL_NAMES,
		externalEditor: text => {
			const command = getEditorCommand();
			return command ? openInEditor(command, text) : Promise.resolve(null);
		},
		scopedModels: session.scopedModels,
		availableToolNames: session.getAdvisorAvailableToolNames(),
		syncBacklog: cfgAdvisorSyncBacklog.get(settings),
		defaultModelLabel: defaultAdvisorModel ? `${defaultAdvisorModel.provider}/${defaultAdvisorModel.id}` : undefined,
	};
	return new AdvisorConfigOverlayComponent(ui, deps, initialScope, initialDoc, {
		loadDoc: async scope => loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs)),
		save: async (scope, doc) => {
			await saveWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs), doc);
			// Re-discover the merged roster (project + user) so the live advisors
			// reflect cross-level precedence, not just the edited file.
			const discovered = await discoverAdvisorConfigs(cwd, agentDir);
			const count = session.applyAdvisorConfigs(
				discovered.advisors,
				discovered.sharedInstructions,
				discovered.sharedMaxNotesPerUpdate,
			);
			host.advisorsChanged();
			if (discovered.warnings.length > 0) {
				host.warn(`WATCHDOG.yml: ${sanitizeDisplayWarnings(discovered.warnings).join("; ")}`);
			}
			host.status(
				count > 0
					? `Saved ${scope} WATCHDOG.yml — ${count} advisor${count === 1 ? "" : "s"} active.`
					: `Saved ${scope} WATCHDOG.yml. Run /advisor on to activate the configured advisors.`,
			);
			host.requestRender();
		},
		close,
		requestRender: () => host.requestRender(),
		notify: message => host.status(message),
		// Scope switches happen inside the overlay; the initial file's warnings
		// were already reported above, so only newly activated files arrive here.
		warn: message => host.warn(message),
		getAdvisorStats: () => session.getAdvisorStats().advisors,
		getUsageReports: async () => {
			const reports = await session.fetchUsageReports?.();
			return reports ? collapseSharedUsageReports(reports) : null;
		},
		getQuotaLimitFilter: (provider, sessionId) => {
			const identity = session.modelRegistry.authStorage.oauth.identity(provider, sessionId ?? session.sessionId);
			return identity ? (report, limit) => limitMatchesActiveAccount(report, limit, identity) : undefined;
		},
	});
}
