/**
 * A small reader for shell command text: it finds each simple command and its
 * words, as the shell reads quotes. It is not a full shell parser. It knows
 * quotes, backslashes and line continuations, comments, `$(…)`, backticks,
 * heredocs, and the characters that end a command. It expands nothing.
 */

/** One level of command text: the top, a `$(…)`, a backtick pair, or a heredoc body. */
interface Level {
	kind: "top" | "sub" | "tick" | "doc";
	/** The finished words of the current simple command. */
	words: string[];
	/** The word being read, or undefined between words. */
	word: string | undefined;
	/** Open `(` inside a `$(…)`, so the matching `)` ends it. */
	depth: number;
	/** True inside double quotes, and always in a heredoc body. */
	quoted: boolean;
}

/** A heredoc whose body starts at the next newline. */
interface Heredoc {
	end: string;
	/** `<<-`: tabs before each body line do not count. */
	tabs: boolean;
	/** A quoted end word: the shell reads the body as plain text. */
	literal: boolean;
	/** The body goes to a shell, such as `bash <<EOF`, which runs it. */
	script: boolean;
}

/** A character that ends a simple command outside quotes. */
const BREAK = /[;&|\n()]/;

/** Characters that end a heredoc's end word. */
const END_WORD_STOP = /[\s;&|()<>]/;

/** A redirect with its target in the same word, such as `2>/dev/null` or `2>&1`. */
const REDIRECT = /^\d*(?:[<>]|&>)/;

/** A redirect with its target in the next word, such as the `2>` in `2> /dev/null`. */
const REDIRECT_ALONE = /^\d*(?:[<>]+|&>>?|[<>]&)$/;

/** An assignment word, such as `A=1` or `A+=1`. */
const ASSIGNMENT = /^\w+\+?=/;

/** Keywords that can come before a command word. */
const KEYWORD = /^(?:!|if|then|do|else|elif|while|until)$/;

/** Commands that run the words after them as a command. */
const WRAPPER =
	/^(?:exec|nohup|command|builtin|sudo|xargs|time|timeout|nice|stdbuf)$/;

/** A wrapper's option or its value, such as `-E` or the `30` in `timeout 30`. */
const WRAPPER_WORD = /^(?:-[\s\S]*|\d+(?:\.\d+)?[smhd]?)$/;

/** Shells that run a `-c` string as a command. */
const SHELL = /^(?:bash|sh|zsh|dash|ksh)$/;

/** A shell option group with `c`, such as `-c` or `-lc`. */
const SCRIPT_OPTION = /^-[a-zA-Z]*c[a-zA-Z]*$/;

/** `find` options that run the words after them, up to `;` or `+`. */
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;

/** `env` options that take the next word as their value. */
const ENV_VALUE_OPTION = /^(?:-[uCSP]|--unset|--chdir|--split-string)$/;

/**
 * The text that stands in a word for a `$(…)` or a backtick pair, so a reader
 * of the words can see that the shell makes that part at run time.
 */
export const SUBSTITUTION = "$(…)";

/**
 * Splits shell text into simple commands, with the words of each as the shell
 * reads them: quotes removed and backslash escapes applied. A `$(…)` or a
 * backtick pair is its own command. A heredoc body with a quoted end word is
 * plain text; in any other body, only its `$(…)` and backticks are commands.
 * A body that goes to a shell, as in `bash <<EOF`, is a script: every line counts.
 *
 * @param text - The shell command text.
 * @returns Each simple command's words, in order.
 * @example
 * simpleCommands("a 'b c'; d $(e)"); // [["a", "b c"], ["e"], ["d", "$(…)"]]
 */
export function simpleCommands(text: string): string[][] {
	return read(text, "top");
}

function read(text: string, kind: "top" | "doc"): string[][] {
	const out: string[][] = [];
	const outer: Level[] = [];
	const heredocs: Heredoc[] = [];
	const fresh = (k: Level["kind"]): Level => ({
		kind: k,
		words: [],
		word: undefined,
		depth: 0,
		quoted: k === "doc",
	});
	let level = fresh(kind);
	const add = (chars: string) => {
		level.word = (level.word ?? "") + chars;
	};
	const endWord = () => {
		if (level.word !== undefined) level.words.push(level.word);
		level.word = undefined;
	};
	const endCommand = () => {
		endWord();
		// A heredoc body's own text is not a command.
		if (level.words.length > 0 && level.kind !== "doc") out.push(level.words);
		level.words = [];
	};
	const open = (k: "sub" | "tick") => {
		outer.push(level);
		level = fresh(k);
	};
	const close = () => {
		endCommand();
		level = outer.pop() ?? level;
		// The outer word now holds text that the shell makes at run time.
		add(SUBSTITUTION);
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i] ?? "";
		if (c === "\\") {
			// A backslash before a newline joins the lines.
			if (text[i + 1] !== "\n") add(text[i + 1] ?? "");
			i++;
		} else if (c === "$" && text.startsWith("((", i + 1)) {
			// Arithmetic: its << is a shift, not a heredoc.
			const end = text.indexOf("))", i + 3);
			const stop = end < 0 ? text.length : end + 2;
			add(text.slice(i, stop));
			i = stop - 1;
		} else if (c === "$" && text[i + 1] === "(") {
			i++;
			open("sub");
		} else if (c === "`") {
			if (level.kind === "tick") close();
			else open("tick");
		} else if (level.quoted) {
			if (c === '"' && level.kind !== "doc") level.quoted = false;
			else add(c);
		} else if (c === '"') {
			level.quoted = true;
			add("");
		} else if (c === "'") {
			const end = text.indexOf("'", i + 1);
			add(text.slice(i + 1, end < 0 ? text.length : end));
			i = end < 0 ? text.length : end;
		} else if (c === "#" && level.word === undefined) {
			const end = text.indexOf("\n", i);
			i = end < 0 ? text.length : end - 1;
		} else if (text.startsWith("<<<", i)) {
			// A here-string: its word is plain input, not a heredoc end word.
			add("<<<");
			i += 2;
		} else if (c === "<" && text[i + 1] === "<") {
			endWord();
			// A shell runs its heredoc body as a script.
			const script = level.words.some((w) => SHELL.test(baseName(w)));
			i = readHeredocStart(text, i + 2, heredocs, script);
		} else if (c === ")" && level.kind === "sub" && level.depth === 0) {
			close();
		} else if (
			c === "&" &&
			(text[i + 1] === ">" || /[<>]$/.test(level.word ?? ""))
		) {
			// Part of a redirect: &>, 2>&1, <&3.
			add(c);
		} else if (BREAK.test(c)) {
			if (c === "(") level.depth++;
			if (c === ")") level.depth = Math.max(0, level.depth - 1);
			endCommand();
			if (c === "\n" && heredocs.length > 0) {
				i = readHeredocBodies(text, i + 1, heredocs, out) - 1;
			}
		} else if (
			level.word === undefined &&
			((c === "{" && /^\s/.test(text[i + 1] ?? " ")) ||
				(c === "}" && /^[\s;&|)]/.test(text[i + 1] ?? " ")))
		) {
			// A group: bash needs a blank after `{`. `{a,b}` is brace expansion.
			endCommand();
		} else if (/\s/.test(c)) {
			endWord();
		} else {
			add(c);
		}
	}
	while (outer.length > 0) close();
	endCommand();
	return out;
}

/**
 * Reads a heredoc's end word after `<<` or `<<-`, and queues the heredoc.
 *
 * @returns The index of the end word's last character.
 */
function readHeredocStart(
	text: string,
	from: number,
	heredocs: Heredoc[],
	script: boolean,
): number {
	let i = from;
	const tabs = text[i] === "-";
	if (tabs) i++;
	while (text[i] === " " || text[i] === "\t") i++;
	let end = "";
	let literal = false;
	while (i < text.length && !END_WORD_STOP.test(text[i] ?? "")) {
		const c = text[i] ?? "";
		if (c === "'" || c === '"') {
			const close = text.indexOf(c, i + 1);
			const stop = close < 0 ? text.length : close;
			end += text.slice(i + 1, stop);
			literal = true;
			i = stop + 1;
		} else if (c === "\\") {
			end += text[i + 1] ?? "";
			literal = true;
			i += 2;
		} else {
			end += c;
			i++;
		}
	}
	if (end) heredocs.push({ end, tabs, literal, script });
	return i - 1;
}

/**
 * Reads the queued heredoc bodies, which start after a newline. A body ends at
 * the line that holds only its end word.
 *
 * @returns The index just after the last body's end line.
 */
function readHeredocBodies(
	text: string,
	from: number,
	heredocs: Heredoc[],
	out: string[][],
): number {
	let at = from;
	for (const doc of heredocs.splice(0)) {
		const start = at;
		let body = text.length;
		while (at < text.length) {
			const newline = text.indexOf("\n", at);
			const stop = newline < 0 ? text.length : newline;
			const line = text.slice(at, stop);
			const next = newline < 0 ? text.length : newline + 1;
			if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.end) {
				body = at;
				at = next;
				break;
			}
			at = next;
		}
		const lines = text.slice(start, body);
		if (doc.script) out.push(...read(lines, "top"));
		else if (!doc.literal) out.push(...read(lines, "doc"));
	}
	return at;
}

/** One command that the text runs. */
export interface RunCommand {
	/** The command word, without its path and in lowercase, then its arguments. Empty for a command of assignments only. */
	words: string[];
	/** The assignments before the command word, such as `A=1`. */
	assigns: string[];
	/** True when `xargs` runs the command, so more words come from its input. */
	input?: true;
}

/**
 * Finds every command that the text runs, from its command word on: it skips
 * assignments, redirects, keywords, and wrappers such as `sudo -E` or
 * `timeout 30`. It also finds the commands that a command runs for it: a
 * shell's `-c` string, `env`'s command, and `find -exec`'s command. The
 * command word's path goes, and it is lowercase, because the macOS file system
 * runs `ENV` as `env`.
 *
 * @param text - The shell command text.
 * @returns Each command's words and the assignments before them.
 * @example
 * commandsRun("FOO=1 sudo -E /usr/bin/env -i ls"); // [{ words: ["env", "-i", "ls"], assigns: ["FOO=1"] }, { words: ["ls"], assigns: [] }]
 */
export function commandsRun(text: string): RunCommand[] {
	return simpleCommands(text).flatMap(runsOf);
}

/** The runs of one simple command's words: the command itself, then the commands it runs. */
function runsOf(all: readonly string[]): RunCommand[] {
	const assigns: string[] = [];
	let at = 0;
	let wrapped = false;
	let input = false;
	while (at < all.length) {
		const word = all[at] ?? "";
		if (ASSIGNMENT.test(word)) {
			assigns.push(word);
			at++;
		} else if (REDIRECT_ALONE.test(word)) {
			at += 2;
		} else if (REDIRECT.test(word) || KEYWORD.test(word)) {
			at++;
		} else if (WRAPPER.test(baseName(word))) {
			wrapped = true;
			input ||= baseName(word) === "xargs";
			at++;
		} else if (wrapped && WRAPPER_WORD.test(word)) {
			at++;
		} else break;
	}
	const rest = all.slice(at);
	const name = baseName(rest[0] ?? "");
	const words = name ? [name, ...rest.slice(1)] : [];
	const runs: RunCommand[] = [
		{ words, assigns, ...(input ? { input: true as const } : {}) },
	];
	if (name === "env") {
		const args = splitEnvArgs(words.slice(1));
		runs.push(...runsOf(args.slice(envParts(args).command)));
	}
	if (SHELL.test(name)) {
		const option = words.findIndex((w, i) => i > 0 && SCRIPT_OPTION.test(w));
		const script = words[option + 1];
		if (option > 0 && script !== undefined) runs.push(...commandsRun(script));
	}
	// Each -exec slice is read once, and the scan goes on after it.
	for (let i = 1; name === "find" && i < words.length; i++) {
		if (!FIND_EXEC.test(words[i] ?? "")) continue;
		const found = words.findIndex((w, j) => j > i && (w === ";" || w === "+"));
		const end = found < 0 ? words.length : found;
		runs.push(...runsOf(words.slice(i + 1, end)));
		i = end;
	}
	return runs.filter((run) => run.words.length > 0 || run.assigns.length > 0);
}

/** What one `env` command does to the environment. */
export interface EnvParts {
	/** It starts from an empty environment: `-i`, `-`, or `--ignore-environment`. */
	clears: boolean;
	/** The names that `-u` or `--unset` removes. */
	unsets: string[];
	/** The assignments after the options, such as `A=1`. */
	assigns: string[];
	/** The index in the arguments where the command that env runs starts. */
	command: number;
}

/**
 * Reads the options and assignments of an `env` command. The words of a `-S`
 * string count as more options, because env splits them into its arguments.
 *
 * @param args - The words after `env`.
 * @returns What env does to the environment, and where its command starts.
 * @example
 * envParts(["-i", "A=1", "ls"]); // { clears: true, unsets: [], assigns: ["A=1"], command: 2 }
 */
export function envParts(args: readonly string[]): EnvParts {
	const parts: EnvParts = {
		clears: false,
		unsets: [],
		assigns: [],
		command: 0,
	};
	const merge = (value: string) => {
		const inner = envParts(value.split(/\s+/).filter(Boolean));
		parts.clears ||= inner.clears;
		parts.unsets.push(...inner.unsets);
		parts.assigns.push(...inner.assigns);
	};
	let i = 0;
	for (; i < args.length; i++) {
		const word = args[i] ?? "";
		if (word === "-" || word === "--ignore-environment") {
			parts.clears = true;
		} else if (word.startsWith("--unset=")) {
			parts.unsets.push(word.slice("--unset=".length));
		} else if (word.startsWith("--split-string=")) {
			merge(word.slice("--split-string=".length));
		} else if (ENV_VALUE_OPTION.test(word)) {
			const value = args[++i] ?? "";
			if (word === "-u" || word === "--unset") parts.unsets.push(value);
			if (word === "-S" || word === "--split-string") merge(value);
		} else if (/^-[^-]/.test(word)) {
			// A group such as -vi. A value option ends it: -uNAME, or -vu NAME.
			const [, letters = "", option, rest = ""] =
				/^-([^uCSP]*)([uCSP]?)([\s\S]*)$/.exec(word) ?? [];
			if (letters.includes("i")) parts.clears = true;
			const value = rest || (option ? (args[++i] ?? "") : "");
			if (option === "u") parts.unsets.push(value);
			if (option === "S") merge(value);
		} else if (!word.startsWith("--")) break;
	}
	for (; i < args.length && ASSIGNMENT.test(args[i] ?? ""); i++) {
		parts.assigns.push(args[i] ?? "");
	}
	parts.command = i;
	return parts;
}

/** env's arguments with each `-S` string split into the words that env reads. */
function splitEnvArgs(args: readonly string[]): string[] {
	const out: string[] = [];
	const split = (value: string) =>
		out.push(...value.split(/\s+/).filter(Boolean));
	for (let i = 0; i < args.length; i++) {
		const word = args[i] ?? "";
		if (word === "-S" || word === "--split-string") split(args[++i] ?? "");
		else if (word.startsWith("--split-string=")) split(word.slice(15));
		else if (word.startsWith("-S")) split(word.slice(2));
		else out.push(word);
	}
	return out;
}

function baseName(word: string): string {
	return word.replace(/^.*\//, "").toLowerCase();
}
