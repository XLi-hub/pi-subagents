import * as fs from "node:fs";
import * as path from "node:path";
import { readParallelHandoffManifest } from "../runs/shared/parallel-handoff.ts";
import type { WorkflowScriptChildResult } from "./scripted-workflow.ts";

export interface WorktreeOverlapChild {
	key: string;
	runId?: string;
	agent?: string;
	handoffPath: string;
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
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_PATH_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_PATHS = 20_000;

function repoIdentity(repoRoot: string): string {
	try { return fs.realpathSync(repoRoot); }
	catch { return path.resolve(repoRoot); }
}

function validPaths(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((file) => typeof file === "string"
		&& file.length > 0 && !file.includes("\0") && !file.startsWith("/")
		&& !/^[A-Za-z]:[/\\]/.test(file) && !file.split("/").some((part) => part === "." || part === ".."));
}

/** Completion-only projection of captured handoffs. It never scans worktrees or invokes Git. */
export function analyzeWorktreeOverlaps(children: readonly WorkflowScriptChildResult[]): WorktreeOverlapReport | undefined {
	const isolated = children.filter((child) => child.worktreeHandoff);
	if (isolated.length < 2) return undefined;
	const rows: WorktreeOverlapChild[] = [];
	let remainingBytes = MAX_REPORT_PATH_BYTES;
	let remainingPaths = MAX_REPORT_PATHS;
	for (const child of isolated) {
		const handoffPath = child.worktreeHandoff!.path;
		const identity = { key: child.key, ...(child.runId ? { runId: child.runId } : {}), ...(child.agent ? { agent: child.agent } : {}), handoffPath };
		if (child.state === "running" || child.detached || child.interrupted) {
			rows.push({ ...identity, error: "Child has not finished; changed paths are unavailable." });
			continue;
		}
		try {
			if (fs.statSync(handoffPath).size > MAX_MANIFEST_BYTES) throw new Error("Handoff exceeds the analysis size limit.");
			const manifest = readParallelHandoffManifest(handoffPath);
			if (!manifest) throw new Error("Handoff is missing.");
			if (child.runId && manifest.runId !== child.runId) throw new Error("Handoff belongs to a different child run.");
			const patches = manifest.groups.flatMap((group) => group.children.map((entry) => ({ group, entry })));
			if (patches.length === 0) throw new Error("Handoff has no captured child patches.");
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
					else if (typeof entry.patch.path !== "string" || !fs.statSync(entry.patch.path, { throwIfNoEntry: false })?.isFile()) {
						row.error = "Captured patch artifact is missing.";
					}
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
		} catch {
			rows.push({ ...identity, error: "Handoff is missing, invalid, or exceeds the analysis size limit." });
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
	return {
		version: 1,
		state: rows.every((row) => row.paths !== undefined) ? "complete" : "incomplete",
		children: rows,
		overlaps: [...files.values()].filter((file) => file.children.length > 1)
			.sort((a, b) => a.repoRoot < b.repoRoot ? -1 : a.repoRoot > b.repoRoot ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
	};
}

/** Keep chat output bounded; the full inventory stays in workflow.worktreeOverlaps. */
export function formatWorktreeOverlaps(report: WorktreeOverlapReport | undefined): string {
	if (!report) return "";
	const unknown = report.children.filter((child) => child.paths === undefined);
	const lines = [`Worktree file overlap analysis: ${report.state}.`];
	if (report.overlaps.length > 0) {
		lines.push(`${report.overlaps.length} shared file path(s); file overlap does not establish a merge conflict.`);
		for (const overlap of report.overlaps.slice(0, 12)) {
			lines.push(`- ${JSON.stringify(overlap.path)} in ${JSON.stringify(overlap.repoRoot)}: ${overlap.children.map((key) => JSON.stringify(key)).join(", ")}`);
		}
		if (report.overlaps.length > 12) lines.push(`- ${report.overlaps.length - 12} more shared paths in workflow.worktreeOverlaps.`);
		const involved = new Set(report.overlaps.slice(0, 12).flatMap((overlap) => overlap.children));
		for (const child of report.children.filter((child) => involved.has(child.key)).slice(0, 12)) {
			lines.push(`Patch ${JSON.stringify(child.key)}: ${JSON.stringify(child.patchPath)}; handoff: ${JSON.stringify(child.handoffPath)}`);
		}
	} else {
		lines.push(report.state === "complete" ? "No shared file paths found in the captured patches." : "No shared file paths found among the available inventories; remaining children are unexamined.");
	}
	if (unknown.length > 0) {
		lines.push(`${unknown.length} unexamined child patch(es): ${unknown.slice(0, 12).map((child) => JSON.stringify(child.key)).join(", ")}.`);
	}
	lines.push("Full changed-path inventory and patch references: workflow.worktreeOverlaps.");
	const text = lines.join("\n");
	return text.length <= 6_000 ? text : `${text.slice(0, 5_800)}\n[Overlap summary truncated; full inventory and references: workflow.worktreeOverlaps.]`;
}
