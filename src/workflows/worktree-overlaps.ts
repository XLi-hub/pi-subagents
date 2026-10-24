import * as fs from "node:fs";
import * as path from "node:path";
import { readParallelHandoffManifest } from "../runs/shared/parallel-handoff.ts";
import type { WorkflowScriptChildResult } from "./scripted-workflow.ts";

export interface WorktreeOverlapChild {
	key: string;
	runId?: string;
	agent?: string;
	handoffPath?: string;
	repoRoot?: string;
	baseCommit?: string;
	patchPath?: string;
	/** Undefined means that this child's changed paths could not be established. */
	paths?: string[];
	error?: string;
}

export interface WorktreeOverlapReport {
	version: 1;
	state: "complete" | "incomplete";
	children: WorktreeOverlapChild[];
	overlaps: Array<{ repoRoot: string; path: string; children: string[] }>;
	/** Connected sets of child patches that share paths, including indirect overlap. */
	reviewGroups: Array<{ children: string[]; sharedPaths: Array<{ repoRoot: string; path: string }> }>;
	/** Examined patches with no shared paths; this does not establish semantic independence. */
	disjointChildren: string[];
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_PATH_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_PATHS = 20_000;

class UnavailableHandoff extends Error {}

function repoIdentity(repoRoot: string): string {
	try { return fs.realpathSync(repoRoot); }
	catch { return path.resolve(repoRoot); }
}

function validPaths(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((file) => typeof file === "string"
		&& file.length > 0 && !file.includes("\0") && !file.startsWith("/")
		&& !/^[A-Za-z]:[/\\]/.test(file) && !file.split("/").some((part) => part === "." || part === ".."));
}

function patchAvailable(patchPath: unknown): boolean {
	try { return typeof patchPath === "string" && fs.statSync(patchPath, { throwIfNoEntry: false })?.isFile() === true; }
	catch { return false; }
}

function reviewGroupsFor(rows: WorktreeOverlapChild[], overlaps: WorktreeOverlapReport["overlaps"]): Pick<WorktreeOverlapReport, "reviewGroups" | "disjointChildren"> {
	const parents = new Map<string, string>();
	const root = (key: string): string => {
		let current = key;
		while (parents.get(current) !== current) current = parents.get(current)!;
		while (key !== current) {
			const next = parents.get(key)!;
			parents.set(key, current);
			key = next;
		}
		return current;
	};
	for (const overlap of overlaps) {
		for (const key of overlap.children) if (!parents.has(key)) parents.set(key, key);
		const first = root(overlap.children[0]!);
		for (const key of overlap.children.slice(1)) parents.set(root(key), first);
	}
	const groups = new Map<string, WorktreeOverlapReport["reviewGroups"][number]>();
	for (const row of rows) {
		if (!parents.has(row.key)) continue;
		const id = root(row.key);
		const group = groups.get(id) ?? { children: [], sharedPaths: [] };
		group.children.push(row.key);
		groups.set(id, group);
	}
	for (const overlap of overlaps) groups.get(root(overlap.children[0]!))!.sharedPaths.push({ repoRoot: overlap.repoRoot, path: overlap.path });
	return { reviewGroups: [...groups.values()], disjointChildren: rows.filter((row) => row.paths !== undefined && !parents.has(row.key)).map((row) => row.key) };
}

/** Automatic completion summary stays quiet for fewer than two isolated children. */
export function analyzeWorktreeOverlaps(children: readonly WorkflowScriptChildResult[]): WorktreeOverlapReport | undefined {
	const isolated = children.filter((child) => child.worktreeHandoff || child.worktreeRequested);
	if (isolated.length < 2) return undefined;
	return inspectWorktreeChanges(isolated);
}

/** Read-only snapshot of selected child evidence; never scans worktrees or invokes Git. */
export function inspectWorktreeChanges(children: readonly WorkflowScriptChildResult[]): WorktreeOverlapReport {
	const rows: WorktreeOverlapChild[] = [];
	let remainingBytes = MAX_REPORT_PATH_BYTES;
	let remainingPaths = MAX_REPORT_PATHS;
	for (const child of children) {
		const handoffPath = child.worktreeHandoff?.path;
		const identity = { key: child.key, ...(child.runId ? { runId: child.runId } : {}), ...(child.agent ? { agent: child.agent } : {}), ...(handoffPath ? { handoffPath } : {}) };
		if (child.state === "running" || child.detached || child.interrupted) {
			rows.push({ ...identity, error: "Child has not finished; changed paths are unavailable." });
			continue;
		}
		if (!handoffPath) {
			rows.push({ ...identity, error: child.worktreeRequested ? "Isolated child returned no worktree handoff." : "Child has no managed-worktree handoff." });
			continue;
		}
		try {
			const stat = fs.statSync(handoffPath, { throwIfNoEntry: false });
			if (!stat) throw new UnavailableHandoff("Handoff is missing.");
			if (!stat.isFile()) throw new UnavailableHandoff("Handoff is not a regular file.");
			if (stat.size > MAX_MANIFEST_BYTES) throw new UnavailableHandoff("Handoff exceeds the analysis size limit.");
			const manifest = readParallelHandoffManifest(handoffPath, MAX_MANIFEST_BYTES);
			if (!manifest) throw new UnavailableHandoff("Handoff is missing.");
			if (child.runId && manifest.runId !== child.runId) throw new UnavailableHandoff("Handoff belongs to a different child run.");
			const patches = manifest.groups.flatMap((group) => group.children.map((entry) => ({ group, entry })));
			if (patches.length === 0) throw new UnavailableHandoff("Handoff has no captured child patches.");
			for (const { group, entry } of patches) {
				const row: WorktreeOverlapChild = {
					...identity,
					key: patches.length === 1 ? child.key : `${child.key}:${entry.index}`,
					agent: entry.agent,
					patchPath: entry.patch.path,
					baseCommit: group.baseCommit,
				};
				if (typeof group.repoRoot !== "string" || !path.isAbsolute(group.repoRoot)) {
					row.error = "Handoff repository identity is unavailable.";
				} else {
					row.repoRoot = repoIdentity(group.repoRoot);
					if (entry.patch.error) row.error = "Patch capture failed; changed paths are unavailable.";
					else if (!patchAvailable(entry.patch.path)) row.error = "Captured patch artifact is missing or unreadable.";
					else if (!validPaths(entry.patch.paths) || (entry.patch.changed && entry.patch.paths.length === 0)) {
						row.error = "Handoff has no complete changed-path inventory.";
					} else {
						const paths = [...new Set(entry.patch.paths)].sort();
						const bytes = paths.reduce((sum, file) => sum + Buffer.byteLength(file, "utf8"), 0);
						if (paths.length > remainingPaths || bytes > remainingBytes) row.error = "Changed-path inventory exceeds the analysis size limit.";
						else {
							remainingPaths -= paths.length;
							remainingBytes -= bytes;
							row.paths = paths;
						}
					}
				}
				rows.push(row);
			}
		} catch (error) {
			rows.push({ ...identity, error: error instanceof UnavailableHandoff ? error.message : "Handoff is invalid or cannot be read." });
		}
	}
	const files = new Map<string, { repoRoot: string; path: string; children: string[] }>();
	for (const row of rows) {
		for (const file of row.paths ?? []) {
			const id = JSON.stringify([row.repoRoot, file]);
			const entry = files.get(id) ?? { repoRoot: row.repoRoot!, path: file, children: [] };
			entry.children.push(row.key);
			files.set(id, entry);
		}
	}
	const overlaps = [...files.values()].filter((file) => file.children.length > 1)
		.sort((a, b) => a.repoRoot < b.repoRoot ? -1 : a.repoRoot > b.repoRoot ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	return {
		version: 1,
		state: rows.every((row) => row.paths !== undefined) ? "complete" : "incomplete",
		children: rows,
		overlaps,
		...reviewGroupsFor(rows, overlaps),
	};
}

/** Keep chat output bounded; the full inventory stays in workflow.worktreeOverlaps. */
export function formatWorktreeOverlaps(report: WorktreeOverlapReport | undefined): string {
	if (!report) return "";
	const unknown = report.children.filter((child) => child.paths === undefined);
	const lines = [`Worktree file overlap analysis: ${report.state}.`];
	lines.push(`${report.children.length - unknown.length}/${report.children.length} child patch inventories examined; ${report.disjointChildren.length} with no shared paths.`);
	// Surface missing evidence before paths so long inventories cannot hide it.
	for (const child of unknown.slice(0, 8)) lines.push(`Unexamined ${JSON.stringify(child.key)}: ${child.error}`);
	if (unknown.length > 8) lines.push(`${unknown.length - 8} more unexamined child patches in workflow.worktreeOverlaps.`);
	if (report.reviewGroups.length > 0) {
		lines.push(`Review together (${report.reviewGroups.length} group(s), including indirect file overlap):`);
		for (const group of report.reviewGroups.slice(0, 8)) lines.push(`  ${group.children.map((key) => JSON.stringify(key)).join(", ")} — ${group.sharedPaths.length} shared path(s)`);
	}
	if (report.overlaps.length > 0) {
		lines.push(`${report.overlaps.length} shared file path(s); file overlap does not establish a merge conflict.`);
		for (const overlap of report.overlaps.slice(0, 12)) {
			lines.push(`- ${JSON.stringify(overlap.path)} in ${JSON.stringify(overlap.repoRoot)}: ${overlap.children.map((key) => JSON.stringify(key)).join(", ")}`);
		}
		if (report.overlaps.length > 12) lines.push(`- ${report.overlaps.length - 12} more shared paths in workflow.worktreeOverlaps.`);
	} else {
		lines.push(report.state === "complete" ? "No shared file paths found in the captured patches." : "No shared file paths found among the available inventories; remaining children are unexamined.");
	}
	const examined = report.children.filter((child) => child.paths !== undefined);
	for (const child of examined.slice(0, 8)) {
		const paths = child.paths!.slice(0, 4).map((file) => JSON.stringify(file)).join(", ");
		lines.push(`Changes ${JSON.stringify(child.key)} (${child.paths!.length} path(s)): ${paths || "none"}${child.paths!.length > 4 ? ", …" : ""}`);
		lines.push(`Patch ${JSON.stringify(child.key)}: ${JSON.stringify(child.patchPath)}; handoff: ${JSON.stringify(child.handoffPath)}`);
	}
	if (examined.length > 8) lines.push(`${examined.length - 8} more child inventories in workflow.worktreeOverlaps.`);
	lines.push("Full changed-path inventory and patch references: workflow.worktreeOverlaps.");
	const text = lines.join("\n");
	return text.length <= 6_000 ? text : `${text.slice(0, 5_800)}\n[Overlap summary truncated; full inventory and references: workflow.worktreeOverlaps.]`;
}
