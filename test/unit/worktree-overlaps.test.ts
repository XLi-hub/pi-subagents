import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { analyzeWorktreeOverlaps, formatWorktreeOverlaps } from "../../src/workflows/worktree-overlaps.ts";
import type { WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";
import type { ParallelHandoffManifest } from "../../src/shared/types.ts";

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
	it("joins child patches by repository and exact path, keeping patch references and complete inventories", (t) => {
		const { dir, child } = fixture(t);
		const api = child("api", ["types.ts", "api.ts", "types.ts"]);
		const ui = child("ui", ["ui.tsx", "types.ts"]);
		const tests = child("tests", ["api.test.ts"]);
		const report = analyzeWorktreeOverlaps([api, ui, tests])!;
		assert.equal(report.state, "complete");
		assert.deepEqual(report.overlaps, [{ repoRoot: dir, path: "types.ts", children: ["api", "ui"] }]);
		assert.deepEqual(report.children[0]?.paths, ["api.ts", "types.ts"]);
		assert.equal(report.children[0]?.patchPath, path.join(dir, "api.patch"));
		assert.equal(report.children[0]?.handoffPath, api.worktreeHandoff!.path);
		assert.match(formatWorktreeOverlaps(report), /file overlap does not establish a merge conflict/);
		assert.match(formatWorktreeOverlaps(report), /api\.patch/);
	});

	it("does not conflate identical filenames in different repositories or disjoint paths", (t) => {
		const { dir, child } = fixture(t);
		const report = analyzeWorktreeOverlaps([child("api", ["types.ts"]), child("ui", ["types.ts"], path.join(dir, "other-repo")), child("tests", [])])!;
		assert.equal(report.state, "complete");
		assert.deepEqual(report.overlaps, []);
		assert.match(formatWorktreeOverlaps(report), /No shared file paths found in the captured patches/);
	});

	it("reports missing or absent inventories as incomplete while retaining known overlaps", (t) => {
		const { child } = fixture(t);
		const missing = child("missing", ["types.ts"]);
		fs.unlinkSync(missing.worktreeHandoff!.path);
		const report = analyzeWorktreeOverlaps([child("a", ["types.ts"]), child("b", ["types.ts"]), child("unknown", undefined), missing])!;
		assert.equal(report.state, "incomplete");
		assert.equal(report.overlaps.length, 1);
		assert.equal(report.children.filter((row) => row.paths === undefined).length, 2);
		assert.match(formatWorktreeOverlaps(report), /2 unexamined child patch/);
		const incomplete = analyzeWorktreeOverlaps([child("valid", ["one.ts"]), missing])!;
		assert.match(formatWorktreeOverlaps(incomplete), /remaining children are unexamined/);
		assert.doesNotMatch(formatWorktreeOverlaps(incomplete), /No shared file paths found in the captured patches/);
	});

	it("uses captured changes from failed children but never claims running or detached patches are complete", (t) => {
		const { child } = fixture(t);
		const failed = { ...child("failed", ["types.ts"]), ok: false };
		const running = { ...child("running", ["types.ts"]), state: "running" as const };
		const report = analyzeWorktreeOverlaps([failed, child("ok", ["types.ts"]), running])!;
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
		const report = analyzeWorktreeOverlaps([mismatch, failed, unsafe, child("ok", ["types.ts"])])!;
		assert.equal(report.state, "incomplete");
		assert.equal(report.children.filter((row) => row.paths !== undefined).length, 1);
		assert.deepEqual(report.overlaps, []);
	});

	it("preserves exact Unicode, tab, newline, and space filenames and bounds the displayed overlap count", (t) => {
		const { child } = fixture(t);
		const paths = ["文件.ts", "a\tb.ts", "a\nb.ts", " spaced .ts", ...Array.from({ length: 20 }, (_, i) => `file-${i}.ts`)];
		const report = analyzeWorktreeOverlaps([child("a", paths), child("b", paths)])!;
		assert.equal(report.overlaps.length, paths.length);
		assert.equal(report.state, "complete");
		assert.match(formatWorktreeOverlaps(report), /12 more shared paths/);
		assert.equal(formatWorktreeOverlaps(report).split("\n").filter((line) => line.startsWith("- ")).length, 13);
	});

	it("bounds analysis input and avoids artifact reads for fewer than two isolated children", (t) => {
		const { child } = fixture(t);
		const oversized = child("large", ["a".repeat(2 * 1024 * 1024)]);
		const normal = child("normal", ["a.ts"]);
		assert.equal(analyzeWorktreeOverlaps([normal, oversized])?.state, "incomplete");
		fs.unlinkSync(normal.worktreeHandoff!.path);
		assert.equal(analyzeWorktreeOverlaps([normal]), undefined);
		assert.equal(formatWorktreeOverlaps(undefined), "");
	});

	it("marks a missing patch incomplete and bounds summaries with long filenames", (t) => {
		const { dir, child } = fixture(t);
		const missing = child("missing", ["shared.ts"]);
		fs.unlinkSync(path.join(dir, "missing.patch"));
		const report = analyzeWorktreeOverlaps([missing, child("ok", ["shared.ts"])])!;
		assert.equal(report.state, "incomplete");
		assert.match(report.children[0]!.error!, /artifact is missing/);
		const paths = Array.from({ length: 12 }, (_, i) => `${i}-${"a".repeat(1_000)}.ts`);
		const text = formatWorktreeOverlaps(analyzeWorktreeOverlaps([child("a", paths), child("b", paths)]));
		assert.ok(text.length <= 6_000);
		assert.match(text, /summary truncated/);
	});
});
