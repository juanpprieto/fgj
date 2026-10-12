import type { Verb } from "../core/verb.ts";
import { apiGet } from "./api.ts";
import {
	boardAdd,
	boardCard,
	boardCreate,
	boardList,
	boardMove,
} from "./board.ts";
import {
	commentAdd,
	commentAttach,
	commentDelete,
	commentEdit,
	commentGet,
	commentList,
} from "./comment.ts";
import { depAdd, depRemove } from "./dep.ts";
import {
	issueClose,
	issueCreate,
	issueEdit,
	issueGet,
	issueList,
	issueReopen,
} from "./issue.ts";
import { labelCreate, labelEdit, labelList } from "./label.ts";
import {
	milestoneClose,
	milestoneCreate,
	milestoneEdit,
	milestoneList,
	milestoneReopen,
} from "./milestone.ts";
import {
	prClose,
	prCreate,
	prEdit,
	prGet,
	prList,
	prMerge,
	prReopen,
} from "./pr.ts";
import { runGet, runLog, runRerun, runWait } from "./run.ts";
import { statusGet, statusWait } from "./status.ts";

/**
 * Every fgj verb. Help, the harness rules, and the dispatcher all read this list,
 * so a verb that is not here does not exist.
 */
export const MANIFEST: readonly Verb[] = [
	commentList as Verb,
	commentGet as Verb,
	commentAdd as Verb,
	commentEdit as Verb,
	commentAttach as Verb,
	commentDelete as Verb,
	issueGet as Verb,
	issueList as Verb,
	issueCreate as Verb,
	issueEdit as Verb,
	issueClose as Verb,
	issueReopen as Verb,
	depAdd as Verb,
	depRemove as Verb,
	labelList as Verb,
	labelCreate as Verb,
	labelEdit as Verb,
	milestoneList as Verb,
	milestoneCreate as Verb,
	milestoneEdit as Verb,
	milestoneClose as Verb,
	milestoneReopen as Verb,
	prGet as Verb,
	prList as Verb,
	prCreate as Verb,
	prEdit as Verb,
	prClose as Verb,
	prReopen as Verb,
	prMerge as Verb,
	statusGet as Verb,
	statusWait as Verb,
	runGet as Verb,
	runLog as Verb,
	runRerun as Verb,
	runWait as Verb,
	boardList as Verb,
	boardCard as Verb,
	boardCreate as Verb,
	boardAdd as Verb,
	boardMove as Verb,
	apiGet as Verb,
];

/**
 * Finds a verb by noun and action, whatever its risk class.
 *
 * @param noun - The noun, for example `comment`.
 * @param action - The action, for example `list`.
 * @returns The verb, or `undefined` when no verb has that noun and action.
 * @example
 * findVerb("comment", "list")?.risk; // "read"
 */
export function findVerb(noun: string, action: string): Verb | undefined {
	return MANIFEST.find((v) => v.noun === noun && v.action === action);
}
