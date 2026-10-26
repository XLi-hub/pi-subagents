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
const MAX_ANALYSIS_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_PATH_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_REFERENCE_BYTES = 4 * 1024 * 1024;
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

function patchAvailable(patchPath: unknown, changed: boolean): boolean {
	try {
		if (typeof patchPath !== "string" || !path.isAbsolute(patchPath)) return false;
		// Open with the current reader's permissions, pin the inode, and avoid
		// blocking if the path was replaced with a FIFO. No patch contents are read.
		const fd = fs.openSync(patchPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		try {
			const stat = fs.fstatSync(fd);
			return stat.isFile() && (!changed || stat.size > 0);
		} finally { fs.closeSync(fd); }
	}
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

/** Read-only snapshot of selected child evidence; never scans worktrees or invokes Git. */
export function inspectWorktreeChanges(children: readonly WorkflowScriptChildResult[]): WorktreeOverlapReport {
	const rows: WorktreeOverlapChild[] = [];
	let remainingBytes = MAX_REPORT_PATH_BYTES;
	let remainingPaths = MAX_REPORT_PATHS;
	let remainingManifestBytes = MAX_ANALYSIS_MANIFEST_BYTES;
	let remainingReferenceBytes = MAX_REPORT_REFERENCE_BYTES;
	for (const child of children) {
		const handoffPath = child.worktreeHandoff?.path;
		const identity = { key: child.key, ...(child.runId ? { runId: child.runId } : {}), ...(child.agent ? { agent: child.agent } : {}), ...(handoffPath ? { handoffPath } : {}) };
		if (child.state === "running" || child.detached || child.interrupted) {
			rows.push({ ...identity, error: "Child has not finished; changed paths are unavailable." });
			continue;
		}
		if (!handoffPath) {
			rows.push({ ...identity, error: "Child has no managed-worktree handoff." });
			continue;
		}
		try {
			const stat = fs.statSync(handoffPath, { throwIfNoEntry: false });
			if (!stat) throw new UnavailableHandoff("Handoff is missing.");
			if (!stat.isFile()) throw new UnavailableHandoff("Handoff is not a regular file.");
			if (stat.size > MAX_MANIFEST_BYTES) throw new UnavailableHandoff("Handoff exceeds the analysis size limit.");
			if (stat.size > remainingManifestBytes) throw new UnavailableHandoff("Handoff exceeds the aggregate analysis read limit.");
			// Charge the full allowed read, including concurrent growth, before reading.
			// Most manifests are small, so allow only their observed size, not 2 MiB each.
			const readLimit = Math.min(MAX_MANIFEST_BYTES, remainingManifestBytes, Math.max(1, stat.size));
			remainingManifestBytes -= readLimit;
			const manifest = readParallelHandoffManifest(handoffPath, readLimit);
			if (!manifest) throw new UnavailableHandoff("Handoff is missing.");
			if (child.runId && manifest.runId !== child.runId) throw new UnavailableHandoff("Handoff belongs to a different child run.");
			// A workflow launch is one child. Composite handoffs cannot be mapped back
			// to that key without inventing identities that runs.run cannot address.
			if (manifest.groups.length !== 1 || manifest.groups[0]!.children.length !== 1) throw new UnavailableHandoff("Handoff does not identify exactly one captured child patch.");
			const group = manifest.groups[0]!;
			const entry = group.children[0]!;
			const row: WorktreeOverlapChild = {
				...identity,
				patchPath: entry.patch.path,
				baseCommit: group.baseCommit,
			};
			if (typeof group.repoRoot !== "string" || !path.isAbsolute(group.repoRoot) || Buffer.byteLength(group.repoRoot, "utf8") > 32 * 1024) {
				row.error = "Handoff repository identity is unavailable.";
			} else if (typeof group.baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(group.baseCommit)) {
				row.error = "Handoff base commit is unavailable.";
			} else {
				row.repoRoot = repoIdentity(group.repoRoot);
				if (entry.patch.error) row.error = "Patch capture failed; changed paths are unavailable.";
				else if (!patchAvailable(entry.patch.path, entry.patch.changed)) row.error = "Captured patch artifact is missing, empty, or unreadable.";
				else if (!validPaths(entry.patch.paths) || entry.patch.changed !== (entry.patch.paths.length > 0)) {
					row.error = "Handoff has no complete changed-path inventory.";
				} else {
					const paths = [...new Set(entry.patch.paths)].sort();
					const bytes = paths.reduce((sum, file) => sum + Buffer.byteLength(file, "utf8"), 0);
					// Shared paths repeat repository/key references in overlaps and groups.
					// Bound that expansion too, including JSON escaping, not just filenames.
					const referenceBytes = paths.reduce((sum, file) => sum + 3 * Buffer.byteLength(JSON.stringify([row.repoRoot, row.key, file]), "utf8") + 256, 0);
					if (paths.length > remainingPaths || bytes > remainingBytes || referenceBytes > remainingReferenceBytes) row.error = "Changed-path inventory exceeds the analysis size limit.";
					else {
						remainingPaths -= paths.length;
						remainingBytes -= bytes;
						remainingReferenceBytes -= referenceBytes;
						row.paths = paths;
					}
				}
			}
			rows.push(row);
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
