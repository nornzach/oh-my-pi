import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcBrowserHost } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-browser-host";
import { resolveBrowserKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { resolveHostedRelayKind } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/kind";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

function session(settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "browser.relay": false, "browser.cmux": false, ...settings }),
	};
}

/** No Tern/cmux/relay environment overrides from the shell running the tests. */
const NO_ENV: Record<string, string | undefined> = {};

let host: RpcBrowserHost | undefined;
afterEach(() => {
	host?.stop();
	host = undefined;
});

async function openExtension(url: string): Promise<WebSocket> {
	const socket = new WebSocket(url);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.onopen = () => resolve();
	socket.onerror = () => reject(new Error(`extension socket failed: ${url}`));
	await promise;
	return socket;
}

describe("RpcBrowserHost", () => {
	it("serves a relay only to holders of its secrets and answers discovery once the panel says hello", async () => {
		host = new RpcBrowserHost();
		const { extensionUrl } = host.start();
		const hosted = resolveHostedRelayKind();
		if (!hosted) throw new Error("expected a hosted relay");
		const origin = new URL(hosted.cdpUrl).origin;

		// The CDP leg is scoped to a secret path; the bare origin serves nothing.
		expect((await fetch(`${origin}/json/version`)).status).toBe(404);
		expect((await fetch(`${hosted.cdpUrl}/json/version`)).status).toBe(503);
		// The extension leg needs its token.
		const withoutToken = new URL(extensionUrl);
		withoutToken.search = "";
		expect((await fetch(withoutToken.href.replace(/^ws/, "http"))).status).toBe(401);

		const extension = await openExtension(extensionUrl);
		extension.send(
			JSON.stringify({
				t: "hello",
				instanceId: "panel",
				userAgent: "Mozilla/5.0 Chrome/136.0.0.0",
				browserVersion: "Chrome/136.0.0.0",
				discardedTabsProtocol: 1,
				tabs: [],
				attachedTabIds: [],
			}),
		);
		let version: Response | undefined;
		for (let i = 0; i < 100 && version?.status !== 200; i++) {
			version = await fetch(`${hosted.cdpUrl}/json/version`);
			if (version.status !== 200) await Bun.sleep(10);
		}
		expect(version?.status).toBe(200);
		const body = (await version?.json()) as { webSocketDebuggerUrl: string };
		expect(body.webSocketDebuggerUrl).toBe(`${hosted.cdpUrl.replace(/^http/, "ws")}/cdp`);
		extension.close();
	});

	it("routes browser opens to the panel, hidden ones as background pages, unless the call picks another browser, until stopped", () => {
		host = new RpcBrowserHost();
		host.start();
		expect(resolveBrowserKind({ action: "open" }, session(), NO_ENV)).toMatchObject({ kind: "relay", hosted: true });
		expect(resolveBrowserKind({ action: "open", headed: true }, session(), NO_ENV)).toMatchObject({ hosted: true });
		expect(resolveBrowserKind({ action: "open", headed: false }, session(), NO_ENV)).toMatchObject({ hosted: true });
		expect(
			resolveBrowserKind({ action: "open" }, session({ "browser.cdpUrl": "http://127.0.0.1:9333" }), NO_ENV).kind,
		).toBe("connected");

		host.stop();
		expect(resolveBrowserKind({ action: "open" }, session(), NO_ENV).kind).toBe("headless");
	});
});

describe("RpcBrowserHost driven pages", () => {
	it("tells the panel which pages the agent drives: a page it creates is grouped, and ungrouped when its client leaves", async () => {
		host = new RpcBrowserHost();
		const { extensionUrl } = host.start();
		const hosted = resolveHostedRelayKind();
		if (!hosted) throw new Error("expected a hosted relay");

		// A fake panel: answers the relay's RPCs and records them.
		const requests: Array<Record<string, unknown>> = [];
		const extension = await openExtension(extensionUrl);
		extension.onmessage = event => {
			const message = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (message.t !== "rpc") return;
			requests.push(message);
			const tab = {
				tabId: 7,
				url: "about:blank",
				title: "",
				active: false,
				discarded: false,
				windowId: 1,
				pinned: false,
			};
			const result =
				message.op === "createTab"
					? { tab: { ...tab, groupId: -1 } }
					: message.op === "group"
						? { grouped: { "7": 1 } }
						: {};
			extension.send(JSON.stringify({ t: "rpcResult", id: message.id, ok: true, result }));
		};
		extension.send(
			JSON.stringify({
				t: "hello",
				instanceId: "panel",
				userAgent: "Mozilla/5.0 Chrome/136.0.0.0",
				browserVersion: "Chrome/136.0.0.0",
				discardedTabsProtocol: 1,
				tabs: [],
				attachedTabIds: [],
			}),
		);
		for (let i = 0; i < 100 && (await fetch(`${hosted.cdpUrl}/json/version`)).status !== 200; i++)
			await Bun.sleep(10);

		const cdp = new WebSocket(`${hosted.cdpUrl.replace(/^http/, "ws")}/cdp`);
		const opened = Promise.withResolvers<void>();
		cdp.onopen = () => opened.resolve();
		await opened.promise;
		const created = Promise.withResolvers<unknown>();
		cdp.onmessage = event => {
			const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
			if (message.id === 1) created.resolve(message.result);
		};
		cdp.send(
			JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "about:blank", background: true } }),
		);
		expect(await created.promise).toMatchObject({ targetId: expect.any(String) });

		const ops = () => requests.map(request => request.op);
		for (let i = 0; i < 100 && !ops().includes("group"); i++) await Bun.sleep(10);
		// A background open creates the page without selecting it, then marks it driven.
		expect(requests.find(request => request.op === "createTab")).toMatchObject({ active: false });
		expect(requests.find(request => request.op === "group")).toMatchObject({ tabIds: [7] });

		cdp.close();
		for (let i = 0; i < 100 && !ops().includes("ungroup"); i++) await Bun.sleep(10);
		expect(requests.find(request => request.op === "ungroup")).toMatchObject({ tabIds: [7] });
		extension.close();
	});
});
