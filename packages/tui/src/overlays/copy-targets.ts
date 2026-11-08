import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { Token, Tokens } from "@oh-my-pi/pi-utils/marked";
import { extractMarkdownLinks, lexDocument } from "../index";

/** A fenced code block extracted from assistant markdown. */
export interface CodeBlock {
	/** Info string after the opening fence (language id), trimmed. */
	lang: string;
	/** Block body with the trailing newline stripped. */
	code: string;
}

/** A blockquote block, as the renderer draws it. */
export interface QuoteBlock {
	/** Block body with the `>` markers removed. */
	text: string;
}

/** A drillable block within an assistant message, in document order. */
export type MessageBlock = ({ kind: "code" } & CodeBlock) | ({ kind: "quote" } & QuoteBlock);

/** A runnable command found in the transcript. */
export interface LastCommand {
	kind: "bash" | "eval";
	code: string;
	/** Highlight language: "bash" for bash, or the resolved eval language ("python"/"javascript"). */
	language: string;
}

/** A node in the RPC copy picker tree. */
export interface CopyTarget {
	id: string;
	label: string;
	hint?: string;
	preview: string;
	language?: string;
	content?: string;
	copyMessage?: string;
	children?: CopyTarget[];
}

/** Minimal session surface needed to assemble copy targets. */
export interface CopySource {
	readonly messages: readonly AgentMessage[];
	getLastVisibleHandoffText(): string | undefined;
}

const MAX_MESSAGES = 50;

/**
 * Split assistant markdown into drillable blocks — fenced code and
 * blockquotes — in document order. Tokenization is the renderer's own
 * ({@link lexDocument}), so fences nested in list items, fence closing rules,
 * list boundaries and lazy quote continuations agree with the screen. Code
 * inside a quote stays part of the quote; indented (non-fenced) code blocks
 * are not offered.
 */
export function extractBlocks(text: string): MessageBlock[] {
	const blocks: MessageBlock[] = [];
	const walk = (tokens: readonly Token[] | undefined): void => {
		if (!tokens) return;
		for (const token of tokens) {
			if (token.type === "code") {
				const code = token as Tokens.Code;
				if (code.codeBlockStyle !== "indented") {
					blocks.push({ kind: "code", lang: (code.lang ?? "").trim(), code: code.text });
				}
			} else if (token.type === "blockquote") {
				blocks.push({ kind: "quote", text: (token as Tokens.Blockquote).text.replace(/\n+$/, "") });
			} else if (token.type === "list") {
				walk((token as Tokens.List).items);
			} else if (token.type === "list_item") {
				walk((token as Tokens.ListItem).tokens);
			}
		}
	};
	walk(lexDocument(text));
	return blocks;
}

/** Extract fenced code blocks from assistant markdown, in document order. */
export function extractCodeBlocks(text: string): CodeBlock[] {
	return extractBlocks(text)
		.filter((b): b is { kind: "code" } & CodeBlock => b.kind === "code")
		.map(b => ({ lang: b.lang, code: b.code }));
}

/** Walk the transcript backwards for the most recent fenced assistant code block. */
export function extractLastCodeBlock(messages: readonly AgentMessage[]): CodeBlock | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const text = assistantText(msg);
		if (!text) continue;
		const blocks = extractCodeBlocks(text);
		if (blocks.length > 0) return blocks[blocks.length - 1];
	}
	return undefined;
}

/** Extract `>`-quoted blocks from assistant markdown, in document order. */
export function extractQuoteBlocks(text: string): QuoteBlock[] {
	return extractBlocks(text)
		.filter((b): b is { kind: "quote" } & QuoteBlock => b.kind === "quote")
		.map(b => ({ text: b.text }));
}

/** A hyperlink found in assistant markdown: inline `[text](href)`, `<autolink>`, bare URL, or reference link. */
export interface LinkTarget {
	/** Visible link label flattened to one display row; falls back to `href` when empty. */
	text: string;
	/** Absolute http(s) URL as marked resolved it. */
	href: string;
}

/**
 * Hyperlinks the renderer would draw for `text`, in document order and
 * deduplicated by href. Tokenization is the renderer's own
 * ({@link extractMarkdownLinks}), so fenced code, code spans, escapes,
 * reference definitions and GFM autolink rules agree with the screen. Only
 * http(s) targets qualify: the result feeds both the clipboard and the system
 * opener, and a `mailto:`/`file:` destination is not something to hand to
 * either from a transcript.
 */
export function extractLinks(text: string): LinkTarget[] {
	const seen = new Set<string>();
	const links: LinkTarget[] = [];
	for (const link of extractMarkdownLinks(text)) {
		if (!/^https?:\/\//i.test(link.href) || seen.has(link.href)) continue;
		seen.add(link.href);
		links.push({ text: link.text, href: link.href });
	}
	return links;
}

/** Walk the transcript backwards for the most recent link in an assistant message. */
export function extractLastLink(messages: readonly AgentMessage[]): LinkTarget | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = assistantText(messages[i]);
		if (!text) continue;
		const links = extractLinks(text);
		if (links.length > 0) return links[links.length - 1];
	}
	return undefined;
}

function extractEvalCode(args: unknown): { code: string; language: string } | undefined {
	if (!args || typeof args !== "object") return undefined;
	const argsObj = args as { cells?: unknown; code?: unknown };
	const cells = Array.isArray(argsObj.cells)
		? argsObj.cells
		: typeof argsObj.code === "string"
			? [argsObj]
			: undefined;
	if (!cells) return undefined;

	const codeBlocks: string[] = [];
	let language = "python";
	let languageResolved = false;
	for (const cell of cells) {
		if (!cell || typeof cell !== "object") continue;
		const code = (cell as { code?: unknown }).code;
		if (typeof code !== "string" || code.length === 0) continue;
		codeBlocks.push(code);
		if (!languageResolved) {
			const lang = (cell as { language?: unknown }).language;
			language = lang === "js" ? "javascript" : "python";
			languageResolved = true;
		}
	}

	return codeBlocks.length > 0 ? { code: codeBlocks.join("\n\n"), language } : undefined;
}

/** Runnable command carried by a `bash`/`eval` tool call, if any. */
export function commandFromToolCall(tc: ToolCall): LastCommand | undefined {
	if (tc.name === "bash" && typeof tc.arguments.command === "string") {
		return { kind: "bash", code: tc.arguments.command, language: "bash" };
	}
	if (tc.name === "eval") {
		const evalResult = extractEvalCode(tc.arguments);
		if (evalResult) return { kind: "eval", code: evalResult.code, language: evalResult.language };
	}
	return undefined;
}

/** Walk the transcript backwards for the most recent bash command or eval code. */
export function extractLastCommand(messages: readonly AgentMessage[]): LastCommand | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");
		for (let j = toolCalls.length - 1; j >= 0; j--) {
			const command = commandFromToolCall(toolCalls[j]!);
			if (command) return command;
		}
	}
	return undefined;
}

/** Concatenated visible text of an assistant message, verbatim; undefined when blank. */
export function assistantText(msg: AgentMessage): string | undefined {
	if (msg.role !== "assistant") return undefined;
	let text = "";
	for (const content of msg.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim() ? text : undefined;
}

function pluralLines(text: string): string {
	const count = text.length === 0 ? 0 : text.split("\n").length;
	return `${count} line${count === 1 ? "" : "s"}`;
}

function blockHint(block: CodeBlock): string {
	const lines = pluralLines(block.code);
	return block.lang ? `${block.lang} · ${lines}` : lines;
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed.replace(/\s+/g, " ");
	}
	return text.trim().replace(/\s+/g, " ");
}

function blockSummaryHint(text: string, codeCount: number, quoteCount: number): string {
	const parts = [pluralLines(text)];
	if (codeCount > 0) parts.push(`${codeCount} code`);
	if (quoteCount > 0) parts.push(`${quoteCount} quote`);
	return parts.join(" · ");
}

function messageTarget(text: string, rank: number): CopyTarget {
	const id = `msg:${rank}`;
	const label = firstLine(text);
	const blocks = extractBlocks(text);
	const messageCopy = rank === 1 ? "Copied last message to clipboard" : "Copied message to clipboard";
	if (blocks.length === 0) {
		return { id, label, hint: pluralLines(text), preview: text, content: text, copyMessage: messageCopy };
	}

	const children: CopyTarget[] = [];
	const codeBlocks: CodeBlock[] = [];
	const quoteBlocks: QuoteBlock[] = [];
	for (const block of blocks) {
		if (block.kind === "code") {
			const index = codeBlocks.length;
			codeBlocks.push(block);
			children.push({
				id: `${id}:code:${index}`,
				label: `Block ${index + 1}`,
				hint: blockHint(block),
				preview: block.code,
				language: block.lang || undefined,
				content: block.code,
				copyMessage: `Copied code block ${index + 1} to clipboard`,
			});
		} else {
			const index = quoteBlocks.length;
			quoteBlocks.push(block);
			children.push({
				id: `${id}:quote:${index}`,
				label: `Quote ${index + 1}`,
				hint: pluralLines(block.text),
				preview: block.text,
				content: block.text,
				copyMessage: `Copied quote block ${index + 1} to clipboard`,
			});
		}
	}

	if (codeBlocks.length > 1) {
		const combined = codeBlocks.map(block => block.code).join("\n\n");
		children.push({
			id: `${id}:all`,
			label: `All ${codeBlocks.length} blocks`,
			hint: pluralLines(combined),
			preview: combined,
			content: combined,
			copyMessage: `Copied ${codeBlocks.length} code blocks to clipboard`,
		});
	}
	if (quoteBlocks.length > 1) {
		const combined = quoteBlocks.map(block => block.text).join("\n\n");
		children.push({
			id: `${id}:all-quotes`,
			label: `All ${quoteBlocks.length} quotes`,
			hint: pluralLines(combined),
			preview: combined,
			content: combined,
			copyMessage: `Copied ${quoteBlocks.length} quote blocks to clipboard`,
		});
	}

	return {
		id,
		label,
		hint: blockSummaryHint(text, codeBlocks.length, quoteBlocks.length),
		preview: text,
		content: text,
		copyMessage: messageCopy,
		children,
	};
}

function commandTarget(command: LastCommand, rank: number): CopyTarget {
	return {
		id: `cmd:${rank}`,
		label: firstLine(command.code) || (command.kind === "bash" ? "Bash command" : "Eval code"),
		hint: `${command.kind} · ${pluralLines(command.code)}`,
		preview: command.code,
		language: command.language,
		content: command.code,
		copyMessage: `Copied ${command.kind === "bash" ? "bash command" : "eval code"} to clipboard`,
	};
}

/** Assemble recent assistant messages and their runnable commands for RPC clients. */
export function buildCopyTargets(source: CopySource): CopyTarget[] {
	const targets: CopyTarget[] = [];
	const pendingCommands: LastCommand[] = [];
	let messageRank = 0;
	let commandRank = 0;
	const appendCommands = (commands: readonly LastCommand[]) => {
		for (const command of commands) {
			commandRank += 1;
			targets.push(commandTarget(command, commandRank));
		}
	};

	for (let i = source.messages.length - 1; i >= 0 && messageRank < MAX_MESSAGES; i--) {
		const message = source.messages[i];
		if (message.role !== "assistant") continue;
		const commands: LastCommand[] = [];
		for (let j = message.content.length - 1; j >= 0; j--) {
			const content = message.content[j];
			if (content.type !== "toolCall") continue;
			const command = commandFromToolCall(content);
			if (command) commands.push(command);
		}
		const text = assistantText(message);
		if (!text) {
			pendingCommands.push(...commands);
			continue;
		}
		messageRank += 1;
		targets.push(messageTarget(text, messageRank));
		appendCommands(pendingCommands);
		appendCommands(commands);
		pendingCommands.length = 0;
	}

	if (messageRank === 0) {
		const handoff = source.getLastVisibleHandoffText();
		if (handoff) {
			targets.unshift({
				id: "handoff",
				label: "Handoff context",
				hint: pluralLines(handoff),
				preview: handoff,
				content: handoff,
				copyMessage: "Copied handoff context to clipboard",
			});
		}
		appendCommands(pendingCommands);
	}

	return targets;
}
