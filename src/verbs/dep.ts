import { FgjError } from "../core/errors.ts";
import { FAILED, type ParsedArgs, type WriteVerb } from "../core/verb.ts";
import { DRY_RUN_FLAG, type IssueRef, issueRefs, REPO_FLAG } from "./common.ts";
import { linked } from "./issue.ts";

/** The most issues that one `dep add` or `dep remove` names. */
const DEP_MAX = 50;

interface DepInput {
	issue: IssueRef;
	on: IssueRef[];
	remote?: IssueRef["remote"];
	single: boolean;
	dryRun: boolean;
}

/** The outcome of one target. */
type DepItem =
	| { on: number; changed: boolean }
	| { on: number; error: ReturnType<FgjError["toJSON"]>["error"] };

/**
 * Builds `dep add` or `dep remove`: makes one issue depend, or stop
 * depending, on one or many issues of the same repository.
 */
function depVerb(action: "add" | "remove"): WriteVerb<DepInput> {
	const hint = `fgj help dep ${action}`;
	const adding = action === "add";
	return {
		risk: "write",
		noun: "dep",
		action,
		summary: adding
			? "Make an issue depend on one or many issues. An existing dependency returns changed:false."
			: "Make an issue stop depending on one or many issues. One that is not a dependency returns changed:false.",
		notes: [
			"The first number is the issue that waits; the rest are the issues it depends on. All are in one repository.",
			"One target returns {changed, number, on}. Two or more return {number, changed, items}: one entry per target. A failed target has error, and the exit code is the code of the first failure.",
			...(adding
				? [
						"A dependency that would close a circle fails with conflict. issue get --fields depends_on,blocks reads the links.",
					]
				: []),
		],
		args: [
			{ name: "issue", description: "The issue that waits: number or URL." },
			{
				name: "on...",
				description: "The issues it depends on: numbers or URLs.",
			},
		],
		flags: [DRY_RUN_FLAG, REPO_FLAG],
		output:
			"One target: {changed, number, on}. Many: {number, changed, items:[{on, changed} or {on, error}]}; changed is true when any target changed. --dry-run adds dry_run and apply.",
		examples: [
			`fgj write dep ${action} 157 142`,
			`fgj write dep ${action} 157 142 143`,
		],
		prepare(args: ParsedArgs): DepInput {
			const { refs, remote } = issueRefs(args, DEP_MAX, hint);
			const [issue, ...rest] = refs;
			if (!issue || rest.length === 0) {
				throw new FgjError(
					"usage",
					`dep ${action} needs the issue that waits and at least one issue it depends on, for example: fgj write dep ${action} 157 142.`,
					hint,
				);
			}
			if (rest.some((r) => r.number === issue.number)) {
				throw new FgjError(
					"usage",
					`Issue ${issue.number} cannot depend on itself.`,
					hint,
				);
			}
			const on = [...new Map(rest.map((r) => [r.number, r])).values()];
			return {
				issue,
				on,
				...(remote ? { remote } : {}),
				single: on.length === 1,
				dryRun: args.flags["dry-run"] === true,
			};
		},
		remoteOf(input) {
			return input.remote;
		},
		async run(input, { target, api, commandWith, commandFor }) {
			const n = input.issue.number;
			const path = `/repos/${target.owner}/${target.name}/issues/${n}/dependencies`;
			let current: (number | string)[];
			try {
				current = await linked(api, target, n, "dependencies");
			} catch (err) {
				if (err instanceof FgjError && err.code === "not_found") {
					throw new FgjError(
						"not_found",
						`Issue ${n} does not exist in ${target.owner}/${target.name}.`,
						hint,
					);
				}
				throw err;
			}
			// A missing target is not_found; a target that already depends on this
			// issue would close a circle, which the server refuses.
			const predictAdd = async (on: number) => {
				const theirs = await linked(api, target, on, "dependencies");
				if (theirs.includes(n)) {
					throw new FgjError("api", "circular dependencies exists", "fgj help");
				}
			};
			const items: DepItem[] = [];
			for (const ref of input.on) {
				const has = current.includes(ref.number);
				const changed = adding ? !has : has;
				if (!changed) {
					items.push({ on: ref.number, changed });
					continue;
				}
				try {
					if (input.dryRun) {
						// Predict the server's refusals, so the plan matches the real run.
						if (adding) await predictAdd(ref.number);
					} else {
						await api.send(adding ? "POST" : "DELETE", path, {
							owner: target.owner,
							repo: target.name,
							index: ref.number,
						});
					}
					items.push({ on: ref.number, changed: true });
				} catch (err) {
					if (!(err instanceof FgjError)) throw err;
					const error =
						err.code === "not_found"
							? new FgjError(
									"not_found",
									`Issue ${ref.number} does not exist in ${target.owner}/${target.name}.`,
									hint,
								)
							: // The server answers a circle with HTTP 500.
								err.code === "api" && /circular/i.test(err.message)
								? new FgjError(
										"conflict",
										`This makes a circular dependency: issue ${ref.number} already depends on issue ${n}, directly or through others.`,
										commandFor(
											"read issue get",
											[input.issue.canonical, ref.canonical],
											{ fields: "number,depends_on,blocks" },
										),
									)
								: err.hint === "fgj help"
									? new FgjError(err.code, err.message, hint)
									: err;
					if (input.single) throw error;
					items.push({ on: ref.number, error: error.toJSON().error });
				}
			}
			const apply = input.dryRun
				? {
						apply: commandWith({ "dry-run": undefined }, [
							input.issue.canonical,
							...input.on.map((r) => r.canonical),
						]),
					}
				: {};
			const dry = input.dryRun ? { dry_run: true } : {};
			if (input.single) {
				return { ...dry, ...(items[0] as DepItem), number: n, ...apply };
			}
			const failed = items.find(
				(i): i is Extract<DepItem, { error: unknown }> => "error" in i,
			);
			return {
				...dry,
				number: n,
				changed: items.some((i) => "changed" in i && i.changed),
				items,
				...apply,
				...(failed ? { [FAILED]: failed.error.code } : {}),
			};
		},
	};
}

/** `fgj write dep add <issue> <on...>`. */
export const depAdd = depVerb("add");

/** `fgj write dep remove <issue> <on...>`. */
export const depRemove = depVerb("remove");
