import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectWorktreeChanges } from "../../src/workflows/worktree-overlaps.ts";
import { type WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";
import type { ParallelHandoffManifest } from "../../src/shared/types.ts";
import { readParallelHandoffManifest } from "../../src/runs/shared/parallel-handoff.ts";

function fixture(t: { after: (fn: () => void) => void }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overlaps-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	function child(key: string, paths: string[] | undefined, repoRoot = dir): WorkflowScriptChildResult {
		const manifestPath = path.join(dir, `${key}.json`);
		const manifest: ParallelHandoffManifest = {
			version: 1, runId: key, mode: "single", source: "foreground", cwd: repoRoot, createdAt: 1, updatedAt: 1,
			groups: [{ stepIndex: 0, repoRoot, baseCommit: "a".repeat(40), children: [{
				index: 0, taskIndex: 0, agent: "worker", status: "completed", summary: "Done",
				patch: { path: path.join(dir, `${key}.patch`), branch: key, changed: paths === undefined || paths.length > 0,
					diffStat: "", filesChanged: paths?.length ?? 1, insertions: 1, deletions: 0, ...(paths ? { paths } : {}) },
			}], cleanup: { state: "complete", pruned: true, tasks: [{ index: 0, path: path.join(dir, key), branch: key, worktreeRemoved: true, branchRemoved: true }] } }],
		};
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		fs.writeFileSync(path.join(dir, `${key}.patch`), "captured patch\n");
		return { key, runId: key, ok: true, output: "Done", artifactPaths: [manifestPath], worktreeHandoff: {
			version: 1, path: manifestPath, groupCount: 1, childCount: 1, changedPatches: 1, cleanupState: "complete",
		} };
	}
	function mutate(child: WorkflowScriptChildResult, update: (manifest: ParallelHandoffManifest) => void) {
		const file = child.worktreeHandoff!.path;
		const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as ParallelHandoffManifest;
		update(manifest);
		fs.writeFileSync(file, JSON.stringify(manifest));
	}
	return { dir, child, mutate };
}

describe("workflow worktree overlap analysis", () => {
	it("does not call currently unreadable patch evidence complete", (t) => {
		const { dir, child } = fixture(t);
		const unreadable = child("unreadable", ["shared.ts"]);
		const readable = child("readable", ["shared.ts"]);
		const file = path.join(dir, "unreadable.patch");
		try {
			fs.chmodSync(file, 0o000);
			try { fs.readFileSync(file); t.skip("This process can read mode-000 files"); return; }
			catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "EACCES"); }
			const report = inspectWorktreeChanges([unreadable, readable])!;
			assert.equal(report.state, "incomplete");
			assert.equal(report.children[0]?.paths, undefined);
			assert.deepEqual(report.overlaps, []);
		} finally { fs.chmodSync(file, 0o600); }
	});
	it("rejects an emptied changed patch but accepts an empty no-change patch", (t) => {
		const { child } = fixture(t);
		const changed = child("changed", ["lost.ts"]);
		const empty = child("empty", []);
		fs.writeFileSync(path.join(path.dirname(changed.worktreeHandoff!.path), "changed.patch"), "");
		fs.writeFileSync(path.join(path.dirname(empty.worktreeHandoff!.path), "empty.patch"), "");
		const report = inspectWorktreeChanges([changed, empty])!;
		assert.equal(report.state, "incomplete");
		assert.equal(report.children[0]?.paths, undefined);
		assert.deepEqual(report.children[1]?.paths, []);
	});
	it("does not invent workflow keys for composite handoff patches", (t) => {
		const { child, mutate } = fixture(t);
		const composite = child("composite", ["shared.ts"]);
		mutate(composite, manifest => {
			const group = manifest.groups[0]!;
			group.children.push({ ...group.children[0]!, index: 1, taskIndex: 1 });
			group.cleanup.tasks.push({ ...group.cleanup.tasks[0]!, index: 1 });
		});
		const report = inspectWorktreeChanges([composite, child("ok", ["shared.ts"])])!;
		assert.equal(report.state, "incomplete");
		assert.deepEqual(report.children.map(row => row.key), ["composite", "ok"]);
		assert.deepEqual(report.overlaps, []);
		assert.match(report.children[0]?.error ?? "", /exactly one/);
	});
	it("bounds reference expansion when many paths repeat a long repository identity", (t) => {
		const { dir, child } = fixture(t);
		const repo = path.join(dir, "r".repeat(4000));
		const files = Array.from({ length: 1000 }, (_, i) => `file-${i}.ts`);
		const report = inspectWorktreeChanges([child("a", files, repo), child("b", files, repo)])!;
		assert.equal(report.state, "incomplete");
		assert.ok(Buffer.byteLength(JSON.stringify(report)) < 100_000);
	});
	it("bounds aggregate handoff reads even when each manifest fits its own limit", (t) => {
		const { child, mutate } = fixture(t);
		const values = Array.from({ length: 6 }, (_, i) => child("c" + i, ["shared.ts"]));
		for (const value of values) mutate(value, manifest => { manifest.groups[0]!.children[0]!.summary = "x".repeat(1500 * 1024); });
		const report = inspectWorktreeChanges(values)!;
		assert.equal(report.state, "incomplete");
		assert.match(report.children.at(-1)?.error ?? "", /aggregate analysis read limit/);
	});
	it("requires consistent change metadata and a captured base identity", (t) => {
		const { child, mutate } = fixture(t);
		const inconsistent = child("inconsistent", ["one.ts"]);
		mutate(inconsistent, manifest => { manifest.groups[0]!.children[0]!.patch.changed = false; });
		const noBase = child("no-base", ["two.ts"]);
		mutate(noBase, manifest => { manifest.groups[0]!.baseCommit = ""; });
		const report = inspectWorktreeChanges([inconsistent, noBase])!;
		assert.equal(report.state, "incomplete");
		assert.equal(report.children.filter(row => row.paths !== undefined).length, 0);
	});
	it("joins child patches by repository and exact path, keeping patch references and complete inventories", (t) => {
		const { dir, child } = fixture(t);
		const api = child("api", ["types.ts", "api.ts", "types.ts"]);
		const ui = child("ui", ["ui.tsx", "types.ts"]);
		const tests = child("tests", ["api.test.ts"]);
		const report = inspectWorktreeChanges([api, ui, tests])!;
		assert.equal(report.state, "complete");
		assert.deepEqual(report.overlaps, [{ repoRoot: dir, path: "types.ts", children: ["api", "ui"] }]);
		assert.deepEqual(report.children[0]?.paths, ["api.ts", "types.ts"]);
		assert.equal(report.children[0]?.patchPath, path.join(dir, "api.patch"));
		assert.equal(report.children[0]?.handoffPath, api.worktreeHandoff!.path);
	});
	it("does not conflate identical filenames in different repositories or disjoint paths", (t) => {
		const { dir, child } = fixture(t);
		const report = inspectWorktreeChanges([child("api", ["types.ts"]), child("ui", ["types.ts"], path.join(dir, "other-repo")), child("tests", [])])!;
		assert.equal(report.state, "complete");
		assert.deepEqual(report.overlaps, []);
	});
	it("reports missing or absent inventories as incomplete while retaining known overlaps", (t) => {
		const { child } = fixture(t);
		const missing = child("missing", ["types.ts"]);
		fs.unlinkSync(missing.worktreeHandoff!.path);
		const report = inspectWorktreeChanges([child("a", ["types.ts"]), child("b", ["types.ts"]), child("unknown", undefined), missing])!;
		assert.equal(report.state, "incomplete");
		assert.equal(report.overlaps.length, 1);
		assert.equal(report.children.filter((row) => row.paths === undefined).length, 2);
		assert.match(report.children[2]?.error ?? "", /no complete changed-path inventory/);
		assert.match(report.children[3]?.error ?? "", /Handoff is missing/);
	});
	it("uses captured changes from failed children but never claims running or detached patches are complete", (t) => {
		const { child } = fixture(t);
		const failed = { ...child("failed", ["types.ts"]), ok: false };
		const running = { ...child("running", ["types.ts"]), state: "running" as const };
		const report = inspectWorktreeChanges([failed, child("ok", ["types.ts"]), running])!;
		assert.equal(report.state, "incomplete");
		assert.deepEqual(report.overlaps[0]?.children, ["failed", "ok"]);
		assert.equal(report.children[2]?.paths, undefined);
	});
	it("keeps invalid identity, capture failures, and malformed path inventories unexamined", (t) => {
		const { child, mutate } = fixture(t);
		const mismatch = child("mismatch", ["types.ts"]);
		mutate(mismatch, (manifest) => { manifest.runId = "other-run"; });
		const failed = child("capture-failed", []);
		mutate(failed, (manifest) => { manifest.groups[0]!.children[0]!.patch.error = "capture failed"; });
		const unsafe = child("unsafe", ["../outside.ts"]);
		const report = inspectWorktreeChanges([mismatch, failed, unsafe, child("ok", ["types.ts"])])!;
		assert.equal(report.state, "incomplete");
		assert.equal(report.children.filter((row) => row.paths !== undefined).length, 1);
		assert.deepEqual(report.overlaps, []);
	});
	it("preserves exact Unicode, tab, newline, and space filenames", (t) => {
		const { child } = fixture(t);
		const paths = ["文件.ts", "a\tb.ts", "a\nb.ts", " spaced .ts", ...Array.from({ length: 20 }, (_, i) => `file-${i}.ts`)];
		const report = inspectWorktreeChanges([child("a", paths), child("b", paths)])!;
		assert.equal(report.overlaps.length, paths.length);
		assert.equal(report.state, "complete");
	});
	it("bounds analysis input and marks a missing single handoff incomplete", (t) => {
		const { child } = fixture(t);
		const oversized = child("large", ["a".repeat(2 * 1024 * 1024)]);
		const normal = child("normal", ["a.ts"]);
		assert.equal(inspectWorktreeChanges([normal, oversized]).state, "incomplete");
		fs.unlinkSync(normal.worktreeHandoff!.path);
		assert.equal(inspectWorktreeChanges([normal]).state, "incomplete");
	});
	it("marks a missing patch incomplete", (t) => {
		const { dir, child } = fixture(t);
		const missing = child("missing", ["shared.ts"]);
		fs.unlinkSync(path.join(dir, "missing.patch"));
		const report = inspectWorktreeChanges([missing, child("ok", ["shared.ts"])])!;
		assert.equal(report.state, "incomplete");
		assert.match(report.children[0]!.error!, /artifact is missing/);
	});
	it("forms transitive review groups while keeping disjoint and unexamined patches separate", (t) => {
		const { dir, child } = fixture(t);
		const report = inspectWorktreeChanges([
			child("api", ["api.ts", "types.ts"]),
			child("ui", ["types.ts", "styles.css"]),
			child("theme", ["styles.css"]),
			child("db", ["schema.sql"]),
			child("migration", ["schema.sql"]),
			child("tests", ["api.test.ts"]),
			child("unknown", undefined),
		])!;
		assert.deepEqual(report.reviewGroups, [
			{ children: ["api", "ui", "theme"], sharedPaths: [{ repoRoot: dir, path: "styles.css" }, { repoRoot: dir, path: "types.ts" }] },
			{ children: ["db", "migration"], sharedPaths: [{ repoRoot: dir, path: "schema.sql" }] },
		]);
		assert.deepEqual(report.disjointChildren, ["tests"]);
	});
	it("retains disjoint child inventories when no files overlap", (t) => {
		const { child } = fixture(t);
		const report = inspectWorktreeChanges([child("api", ["api.ts"]), child("ui", ["ui.tsx"])])!;
		assert.deepEqual(report.reviewGroups, []);
		assert.deepEqual(report.disjointChildren, ["api", "ui"]);
	});
	it("bounds the actual handoff read and accepts inventories exactly at the byte limit", (t) => {
		const { child } = fixture(t);
		const value = child("api", ["文件.ts"]);
		const file = value.worktreeHandoff!.path;
		const bytes = fs.statSync(file).size;
		assert.deepEqual(readParallelHandoffManifest(file, bytes)?.groups[0]?.children[0]?.patch.paths, ["文件.ts"]);
		assert.throws(() => readParallelHandoffManifest(file, bytes - 1), /read limit/);
		assert.throws(() => readParallelHandoffManifest(file, 0), /Invalid parallel handoff read limit/);
	});
	it("keeps explicitly selected children without a handoff visible", (t) => {
		const { child } = fixture(t);
		const failed: WorkflowScriptChildResult = { key: "setup-failed", ok: false, output: "Setup failed", artifactPaths: [] };
		const report = inspectWorktreeChanges([child("api", ["api.ts"]), failed])!;
		assert.equal(report.state, "incomplete");
		assert.equal(report.children.length, 2);
		assert.equal(report.children[1]?.handoffPath, undefined);
		assert.match(report.children[1]?.error ?? "", /no managed-worktree handoff/);
	});
});
