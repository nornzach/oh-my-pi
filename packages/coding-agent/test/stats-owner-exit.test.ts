import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const LINGER_MS = 1_500;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("omp stats with an owner", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	/** Runs the real dashboard command on a private home until it reports its address. */
	async function startDashboard(env: Record<string, string>): Promise<Bun.Subprocess<"ignore", "pipe", "ignore">> {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-owner-"));
		const server = Bun.spawn([process.execPath, CLI, "stats", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			env: {
				...process.env,
				HOME: home,
				PI_CODING_AGENT_DIR: path.join(home, "agent"),
				PI_NOTIFICATIONS: "off",
				...env,
			},
		});
		cleanups.push(async () => {
			server.kill("SIGKILL");
			await server.exited;
			await fs.rm(home, { recursive: true, force: true });
		});
		const decoder = new TextDecoder();
		let output = "";
		for await (const chunk of server.stdout) {
			output += decoder.decode(chunk);
			if (output.includes("Dashboard available")) return server;
		}
		throw new Error(`dashboard exited before it was ready: ${output}`);
	}

	function startOwner(): Bun.Subprocess {
		const owner = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], { stdin: "ignore" });
		cleanups.push(async () => {
			owner.kill("SIGKILL");
			await owner.exited;
		});
		return owner;
	}

	// A desktop app that is force-killed or crashes runs no cleanup. Its dashboard
	// server used to keep running forever, one more each time.
	it("exits once the process that started it is gone, even with no goodbye", async () => {
		const owner = startOwner();
		const server = await startDashboard({ PI_STATS_OWNER_PID: String(owner.pid) });

		owner.kill("SIGKILL");
		await owner.exited;

		const exited = await Promise.race([server.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
		expect(exited).toBe(true);
	}, 60_000);

	it.each([
		["no owner", undefined],
		["a value that isn't a process id", "not-a-pid"],
	])(
		"keeps serving with %s, as a dashboard started by hand must",
		async (_name, value) => {
			const server = await startDashboard(value === undefined ? {} : { PI_STATS_OWNER_PID: value });
			await Bun.sleep(LINGER_MS);
			expect(isAlive(server.pid)).toBe(true);
		},
		60_000,
	);
});
