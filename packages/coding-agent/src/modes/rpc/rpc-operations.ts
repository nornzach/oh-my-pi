import { $which, compareVersions, getSSHConfigPath, prompt, VERSION } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { type SSHHost, sshCapability } from "../../capability/ssh";
import { getLatestRelease } from "../../cli/update-cli";
import { loadCapability } from "../../discovery";
import securityValidationPrompt from "../../prompts/security/validate-request.md" with { type: "text" };
import type { SecurityFinding, SecurityScanBundle } from "../../security/contracts";
import { getSecurityCoordinator, type SecurityOperationSnapshot } from "../../security/coordinator";
import type { SecurityTargetRequest } from "../../security/preflight";
import { SecurityStore } from "../../security/store";
import type { AgentSession } from "../../session/agent-session";
import {
	readSSHConfigFile,
	removeSSHHost,
	type SSHHostConfig,
	updateSSHHost,
	validateHostName,
} from "../../ssh/config-writer";
import {
	ensureConnection,
	ensureHostInfo,
	getHostInfoForHost,
	invalidateHostMetadata,
	type SSHConnectionTarget,
} from "../../ssh/connection-manager";
import * as git from "../../utils/git";
import type {
	RpcOmpUpdateResult,
	RpcSecurityDashboardResult,
	RpcSecurityDispositionStatus,
	RpcSecurityFindingInfo,
	RpcSecurityOperationInfo,
	RpcSecurityScanInfo,
	RpcSecurityScanResult,
	RpcSecurityTargetInput,
	RpcSshHostInfo,
	RpcSshHostInput,
	RpcSshHostsResult,
	RpcSshTestResult,
} from "./rpc-types";

function securityCoordinator(session: AgentSession) {
	return getSecurityCoordinator({
		cwd: session.sessionManager.getCwd(),
		settings: session.settings,
		authStorage: session.modelRegistry.authStorage,
		modelRegistry: session.modelRegistry,
		activeModel: session.model,
		sessionId: session.sessionId,
		agentId: session.getAgentId(),
		asyncJobManager: session.asyncJobManager,
	});
}

function projectFinding(finding: SecurityFinding): RpcSecurityFindingInfo {
	const location = finding.occurrences[0]?.locations[0] ?? finding.evidence.find(item => item.location)?.location;
	return {
		id: finding.id,
		scanId: finding.scanId,
		title: finding.title,
		summary: finding.summary,
		severity: finding.severity.level,
		confidence: finding.confidence.level,
		...(location ? { path: location.path, line: location.startLine } : {}),
		disposition: finding.disposition.status,
		validation: finding.validation.status,
		...(finding.remediation ? { remediation: finding.remediation } : {}),
		evidence: finding.evidence.map(item => ({
			label: item.label,
			explanation: item.explanation,
			...(item.excerpt ? { excerpt: item.excerpt } : {}),
			...(item.location ? { path: item.location.path, line: item.location.startLine } : {}),
		})),
	};
}

function projectScan(bundle: SecurityScanBundle): RpcSecurityScanInfo {
	const { scan } = bundle;
	return {
		id: scan.id,
		status: scan.status,
		createdAt: scan.createdAt,
		...(scan.completedAt ? { completedAt: scan.completedAt } : {}),
		producer: scan.producer.name,
		findingCount: bundle.findings.length,
		target: {
			kind: scan.target.kind,
			displayName: scan.target.displayName,
			...(scan.target.revision ? { revision: scan.target.revision } : {}),
			...(scan.target.baseRevision ? { baseRevision: scan.target.baseRevision } : {}),
			...(scan.target.headRevision ? { headRevision: scan.target.headRevision } : {}),
		},
	};
}

function projectSecurityBundle(bundle: SecurityScanBundle): RpcSecurityScanResult {
	return { scan: projectScan(bundle), findings: bundle.findings.map(projectFinding) };
}

function projectOperation(operation: SecurityOperationSnapshot): RpcSecurityOperationInfo {
	return {
		operationId: operation.operationId,
		planId: operation.planId,
		scanId: operation.scanId,
		phase: operation.phase,
		createdAt: operation.createdAt,
		updatedAt: operation.updatedAt,
		findingCount: operation.findingCount,
		...(operation.error ? { error: operation.error } : {}),
	};
}

export async function buildRpcSecurityDashboard(session: AgentSession): Promise<RpcSecurityDashboardResult> {
	const cwd = session.sessionManager.getCwd();
	const store = await SecurityStore.openForCwd(cwd);
	const [summaries, operations, branch, shortSha] = await Promise.all([
		store.listScans(),
		securityCoordinator(session).listOperations(),
		git.branch.current(cwd),
		git.head.short(cwd),
	]);
	const bundles = await Promise.all(summaries.map(summary => store.getBundle(summary.id)));
	const scans = bundles.filter((bundle): bundle is SecurityScanBundle => bundle !== null).map(projectScan);
	const latestBundle = bundles.find((bundle): bundle is SecurityScanBundle => bundle !== null);
	const model = session.model;
	return {
		enabled: session.settings.get("security.enabled") === true,
		modelReady: model !== undefined,
		...(model ? { modelLabel: `${model.provider}/${model.id}` } : {}),
		repositoryRoot: store.repositoryRoot,
		...(branch || shortSha ? { revision: [branch, shortSha].filter(Boolean).join(" · ") } : {}),
		scans,
		operations: operations.map(projectOperation),
		...(latestBundle ? { latest: projectSecurityBundle(latestBundle) } : {}),
	};
}

export async function buildRpcSecurityScan(session: AgentSession, scanId: string): Promise<RpcSecurityScanResult> {
	const bundle = await (await SecurityStore.openForCwd(session.sessionManager.getCwd())).getBundle(scanId);
	if (!bundle) throw new Error(`Unknown security scan: ${scanId}`);
	return projectSecurityBundle(bundle);
}

export async function startRpcSecurityScan(
	session: AgentSession,
	target: RpcSecurityTargetInput,
): Promise<RpcSecurityOperationInfo> {
	const coordinator = securityCoordinator(session);
	const plan = await coordinator.preflight({ target: target as SecurityTargetRequest });
	return projectOperation(await coordinator.start({ planId: plan.id }));
}

export async function cancelRpcSecurityScan(
	session: AgentSession,
	operationId: string,
): Promise<{ cancelled: boolean }> {
	return { cancelled: await securityCoordinator(session).cancel(operationId) };
}

export async function setRpcSecurityDisposition(
	session: AgentSession,
	scanId: string,
	findingId: string,
	status: RpcSecurityDispositionStatus,
	rationale?: string,
): Promise<RpcSecurityFindingInfo> {
	const normalizedRationale = rationale?.trim();
	if (status !== "open" && !normalizedRationale) throw new Error(`${status} requires a rationale`);
	const finding = await (await SecurityStore.openForCwd(session.sessionManager.getCwd())).updateDisposition(
		scanId,
		findingId,
		{
			status,
			...(normalizedRationale ? { rationale: normalizedRationale } : {}),
			updatedAt: new Date().toISOString(),
			actor: "operator",
		},
	);
	return projectFinding(finding);
}

export async function buildRpcSecurityValidationPrompt(
	session: AgentSession,
	scanId: string,
	findingId: string,
): Promise<string> {
	const finding = await (await SecurityStore.openForCwd(session.sessionManager.getCwd())).getFinding(
		scanId,
		findingId,
	);
	if (!finding) throw new Error(`Unknown security finding: ${findingId}`);
	return prompt
		.render(securityValidationPrompt, {
			findingUri: `security://scans/${scanId}/findings/${findingId}`,
			scanId,
			findingId,
		})
		.trim();
}

function toConnectionTarget(name: string, host: RpcSshHostInput): SSHConnectionTarget {
	return {
		name,
		host: host.host,
		...(host.username ? { username: host.username } : {}),
		...(host.port ? { port: host.port } : {}),
		...(host.keyPath ? { keyPath: host.keyPath } : {}),
		...(host.compat ? { compat: true } : {}),
	};
}

function validateSshHost(name: string, host: RpcSshHostInput): void {
	const nameError = validateHostName(name);
	if (nameError) throw new Error(nameError);
	if (!host.host.trim()) throw new Error("Host address cannot be empty");
	if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) {
		throw new Error("Port must be an integer between 1 and 65535");
	}
}

async function projectSshHost(host: SSHHost): Promise<RpcSshHostInfo> {
	const cached = await getHostInfoForHost(toConnectionTarget(host.name, host));
	return {
		name: host.name,
		host: host.host,
		...(host.username ? { username: host.username } : {}),
		...(host.port ? { port: host.port } : {}),
		...(host.keyPath ? { keyPath: host.keyPath } : {}),
		...(host.description ? { description: host.description } : {}),
		...(host.compat ? { compat: true } : {}),
		scope: host._source.level,
		editable: host._source.provider === "ssh-json" && host._source.level !== "native",
		source: host._source.path,
		...(cached
			? {
					os: cached.os,
					shell: cached.shell,
					...(cached.compatShell ? { compatShell: cached.compatShell } : {}),
					...(cached.transferShell ? { transferShell: cached.transferShell } : {}),
				}
			: {}),
	};
}

export async function buildRpcSshHosts(session: AgentSession): Promise<RpcSshHostsResult> {
	const result = await loadCapability<SSHHost>(sshCapability.id, { cwd: session.sessionManager.getCwd() });
	return {
		openSshAvailable: $which("ssh") !== undefined,
		hosts: await Promise.all(result.items.map(projectSshHost)),
		warnings: result.warnings,
	};
}

export async function manageRpcSshHost(
	session: AgentSession,
	action: "create" | "update" | "delete",
	scope: "user" | "project",
	name: string,
	previousName?: string,
	previousScope?: "user" | "project",
	host?: RpcSshHostInput,
): Promise<RpcSshHostInfo | { deleted: true }> {
	const cwd = session.sessionManager.getCwd();
	const filePath = getSSHConfigPath(scope, cwd);
	if (action === "delete") {
		await removeSSHHost(filePath, name);
		await invalidateHostMetadata([name]);
		resetCapabilities();
		return { deleted: true };
	}
	if (!host) throw new Error("SSH host payload is required");
	validateSshHost(name, host);
	const config: SSHHostConfig = {
		host: host.host.trim(),
		...(host.username?.trim() ? { username: host.username.trim() } : {}),
		...(host.port ? { port: host.port } : {}),
		...(host.keyPath?.trim() ? { keyPath: host.keyPath.trim() } : {}),
		...(host.description?.trim() ? { description: host.description.trim() } : {}),
		...(host.compat ? { compat: true } : {}),
	};
	if (action === "create") {
		const existing = await readSSHConfigFile(filePath);
		if (existing.hosts?.[name]) throw new Error(`Host "${name}" already exists`);
	}
	const sourceName = previousName ?? name;
	const sourcePath = getSSHConfigPath(previousScope ?? scope, cwd);
	if (action === "update" && sourcePath !== filePath) {
		const [source, destination] = await Promise.all([readSSHConfigFile(sourcePath), readSSHConfigFile(filePath)]);
		if (!source.hosts?.[sourceName]) throw new Error(`Host "${sourceName}" not found`);
		if (destination.hosts?.[name]) throw new Error(`Host "${name}" already exists in ${scope} config`);
		await updateSSHHost(filePath, name, config);
		try {
			await removeSSHHost(sourcePath, sourceName);
		} catch (error) {
			await removeSSHHost(filePath, name).catch(() => undefined);
			throw error;
		}
	} else if (action === "update" && previousName && previousName !== name) {
		const existing = await readSSHConfigFile(filePath);
		if (!existing.hosts?.[previousName]) throw new Error(`Host "${previousName}" not found`);
		if (existing.hosts[name]) throw new Error(`Host "${name}" already exists`);
		await updateSSHHost(filePath, name, config);
		try {
			await removeSSHHost(filePath, previousName);
		} catch (error) {
			await removeSSHHost(filePath, name).catch(() => undefined);
			throw error;
		}
	} else {
		await updateSSHHost(filePath, name, config);
	}
	await invalidateHostMetadata(new Set([sourceName, name]));
	resetCapabilities();
	return {
		name,
		...config,
		scope,
		editable: true,
		source: filePath,
	};
}

export async function testRpcSshHost(name: string, host: RpcSshHostInput): Promise<RpcSshTestResult> {
	validateSshHost(name, host);
	const target = toConnectionTarget(name, host);
	const checkedAt = new Date().toISOString();
	// Keep the backend deadline below the GUI transport timeout. Every nested
	// ssh helper shares this signal, so sequential check/start/probe calls consume
	// one total budget instead of each receiving a fresh 30-second window.
	const signal = AbortSignal.timeout(50_000);
	try {
		await ensureConnection(target, signal);
		const info = await ensureHostInfo(target, signal);
		return {
			name,
			ok: true,
			checkedAt,
			os: info.os,
			shell: info.shell,
			...(info.compatShell ? { compatShell: info.compatShell } : {}),
			...(info.transferShell ? { transferShell: info.transferShell } : {}),
		};
	} catch (error) {
		if (signal.aborted)
			return { name, ok: false, checkedAt, error: "SSH connection test timed out after 50 seconds" };
		return { name, ok: false, checkedAt, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function buildRpcOmpUpdate(): Promise<RpcOmpUpdateResult> {
	const release = await getLatestRelease();
	return {
		currentVersion: VERSION,
		latestVersion: release.version,
		updateAvailable: compareVersions(release.version, VERSION) > 0,
		checkedAt: new Date().toISOString(),
		distribution: "bundled",
		installStrategy: "gui-update",
	};
}
