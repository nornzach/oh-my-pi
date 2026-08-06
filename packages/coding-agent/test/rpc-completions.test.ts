import { describe, expect, it } from "bun:test";
import { buildRpcCommandArgCompletions } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-completions";

/**
 * Contract tests for get_command_arg_completions routing (static subcommand
 * vs dynamic server-name vs none). Env-dependent data paths (actual MCP
 * server names from live config, /move directories) are covered by CDP smoke
 * instead — here we pin the deterministic routing contract.
 */

const cwd = process.cwd();

describe("buildRpcCommandArgCompletions", () => {
	it("completes static subcommands by prefix", async () => {
		const items = await buildRpcCommandArgCompletions(cwd, "todo", "d");
		expect(items).not.toBeNull();
		const values = items!.map(item => item.value);
		expect(values).toContain("done ");
		expect(values).toContain("drop ");
	});

	it("returns null once past the subcommand for a static-only command", async () => {
		expect(await buildRpcCommandArgCompletions(cwd, "todo", "done extra")).toBeNull();
	});

	it("completes /mcp subcommands while the subcommand is still being typed", async () => {
		const items = await buildRpcCommandArgCompletions(cwd, "mcp", "ad");
		expect(items).not.toBeNull();
		expect(items!.map(item => item.value)).toContain("add ");
	});

	it("returns null for /mcp subcommands that do not take a server name", async () => {
		// "add" takes flags, not a server name — no argument completion.
		expect(await buildRpcCommandArgCompletions(cwd, "mcp", "add ")).toBeNull();
	});

	it("returns null for unknown commands", async () => {
		expect(await buildRpcCommandArgCompletions(cwd, "definitely-not-a-command", "")).toBeNull();
	});

	it("carries usage hints and descriptions from the subcommand defs", async () => {
		const items = await buildRpcCommandArgCompletions(cwd, "todo", "done");
		expect(items).toHaveLength(1);
		expect(items![0]?.value).toBe("done ");
		expect(items![0]?.hint).toBe("[<task|phase>]");
		expect(items![0]?.description).toContain("completed");
	});
});
