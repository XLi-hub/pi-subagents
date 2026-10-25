import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runWorkflowScript, type WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";
import type { ParallelHandoffManifest } from "../../src/shared/types.ts";

function fixture(t: { after: (fn: () => void) => void }) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-changes-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	function child(key: string, paths: string[]): WorkflowScriptChildResult {
		const handoffPath = path.join(dir, `${key}.json`);
		const patchPath = path.join(dir, `${key}.patch`);
		const manifest: ParallelHandoffManifest = {
			version: 1, runId: `run-${key}`, mode: "single", source: "foreground", cwd: dir, createdAt: 1, updatedAt: 1,
			groups: [{ stepIndex: 0, repoRoot: dir, baseCommit: "a".repeat(40), children: [{
				index: 0, taskIndex: 0, agent: "worker", status: "completed", summary: key,
				patch: { path: patchPath, branch: key, changed: paths.length > 0, diffStat: "", filesChanged: paths.length, insertions: 1, deletions: 0, paths },
			}], cleanup: { state: "complete", pruned: true, tasks: [{ index: 0, path: path.join(dir, key), branch: key, worktreeRemoved: true, branchRemoved: true }] } }],
		};
		fs.writeFileSync(handoffPath, JSON.stringify(manifest));
		fs.writeFileSync(patchPath, "captured patch\n");
		return { key, runId: `run-${key}`, ok: true, output: key, artifactPaths: [handoffPath], worktreeRequested: true,
			worktreeHandoff: { version: 1, path: handoffPath, groupCount: 1, childCount: 1, changedPatches: paths.length > 0 ? 1 : 0, cleanupState: "complete" } };
	}
	return { dir, child };
}

const noStatus = async (): Promise<WorkflowScriptChildResult> => { throw new Error("Inspection must not widen into a status lookup."); };

describe("runs.worktreeChanges", () => {
	it("bounds cumulative selected-key inspections without charging rejected selections", async (t) => {
		const { child } = fixture(t);
		const run = () => runWorkflowScript({
			script: `
				await runs.run("api", { agent: "worker", task: "API" });
				for (let index = 0; index < 255; index++) await runs.worktreeChanges(["api"]);
				try { await runs.worktreeChanges(["api", "unknown"]); } catch {}
				const last = await runs.worktreeChanges(["api"]);
				let error = "";
				try { await runs.worktreeChanges(["api"]); } catch (caught) { error = caught.message; }
				const empty = await runs.worktreeChanges([]);
				return { last: last.state, empty: empty.state, error };
			`,
			async launch() { return child("api", ["api.ts"]); }, status: noStatus,
		});
		for (let workflow = 0; workflow < 2; workflow++) {
			const result = await run();
			assert.deepEqual(result.value, { last: "complete", empty: "complete", error: "runs.worktreeChanges exceeds the workflow limit of 256 selected-key inspections." });
		}
	});
	it("lets a workflow launch explicit reviewers for the captured file groups", async (t) => {
		const { child } = fixture(t);
		const launches: Array<{ key: string; task: unknown }> = [];
		const result = await runWorkflowScript({
			script: `
				const writers = await runs.all([{ key: "api", agent: "worker", task: "API" }, { key: "ui", agent: "worker", task: "UI" }]);
				const changes = await runs.worktreeChanges(writers.map(child => child.key));
				const reviews = await runs.all(changes.reviewGroups.map((group, i) => ({ key: "review-" + i, agent: "reviewer", task: group.children.join(", ") })));
				return { changes, reviews: reviews.map(child => child.output) };
			`,
			async launch(key, params) {
				launches.push({ key, task: params.task });
				return key.startsWith("review-") ? { key, ok: true, output: "Reviewed", artifactPaths: [] } : child(key, ["types.ts", `${key}.ts`]);
			},
			status: noStatus,
		});
		const value = result.value as { changes: { state: string; reviewGroups: Array<{ children: string[] }> }; reviews: string[] };
		assert.equal(value.changes.state, "complete");
		assert.deepEqual(value.changes.reviewGroups[0]?.children, ["api", "ui"]);
		assert.deepEqual(value.reviews, ["Reviewed"]);
		assert.deepEqual(launches, [{ key: "api", task: "API" }, { key: "ui", task: "UI" }, { key: "review-0", task: "api, ui" }]);
	});

	it("inspects one child and an empty selection without extra launches", async (t) => {
		const { child } = fixture(t);
		let launches = 0;
		const result = await runWorkflowScript({
			script: `await runs.run("api", { agent: "worker", task: "API" }); return [await runs.worktreeChanges(["api"]), await runs.worktreeChanges([])];`,
			async launch(key) { launches++; return child(key, ["api.ts"]); }, status: noStatus,
		});
		const [one, empty] = result.value as Array<{ state: string; children: Array<{ paths: string[] }> }>;
		assert.equal(one!.state, "complete");
		assert.deepEqual(one!.children[0]?.paths, ["api.ts"]);
		assert.equal(empty!.state, "complete");
		assert.deepEqual(empty!.children, []);
		assert.equal(launches, 1);
	});

	it("accepts the full 64-key bound without dropping group members", async (t) => {
		const { child } = fixture(t);
		const result = await runWorkflowScript({
			script: `const writers = await runs.all(Array.from({ length: 64 }, (_, i) => ({ key: "child-" + i, agent: "worker", task: "Work" }))); return await runs.worktreeChanges(writers.map(child => child.key));`,
			async launch(key) { return child(key, ["shared.ts"]); }, status: noStatus,
		});
		const value = result.value as { state: string; children: unknown[]; reviewGroups: Array<{ children: string[] }> };
		assert.equal(value.state, "complete");
		assert.equal(value.children.length, 64);
		assert.equal(value.reviewGroups[0]?.children.length, 64);
	});

	it("uses host-owned evidence even when the script mutates returned child metadata", async (t) => {
		const { dir, child } = fixture(t);
		const original = child("api", ["api.ts"]);
		const result = await runWorkflowScript({
			script: `const result = await runs.run("api", { agent: "worker", task: "API" }); result.worktreeHandoff.path = args.forgedPath; result.key = "forged"; return await runs.worktreeChanges(["api"]);`,
			args: { forgedPath: path.join(dir, "caller-controlled.json") },
			async launch() { return original; }, status: noStatus,
		});
		const value = result.value as { state: string; children: Array<{ key: string; handoffPath: string }> };
		assert.equal(value.state, "complete");
		assert.equal(value.children[0]?.key, "api");
		assert.equal(value.children[0]?.handoffPath, original.worktreeHandoff!.path);
	});

	it("keeps child keys scoped to this workflow and does not resolve raw run ids", async (t) => {
		const { child } = fixture(t);
		const launch = async (key: string) => child(key, ["api.ts"]);
		await runWorkflowScript({ script: `return await runs.run("api", { agent: "worker", task: "API" });`, launch, status: noStatus });
		await assert.rejects(runWorkflowScript({ script: `return await runs.worktreeChanges(["api"]);`, launch, status: noStatus }), /requires a prior.*api/);
		await assert.rejects(runWorkflowScript({
			script: `const child = await runs.run("api", { agent: "worker", task: "API" }); return await runs.worktreeChanges([child.runId]);`, launch, status: noStatus,
		}), /requires a prior.*run-api/);
	});

	for (const [expression, error] of [
		["null", /requires an array/],
		["({ key: 'api' })", /requires an array/],
		["['../handoff.json']", /key must be/],
		["['api', 'api']", /duplicate key/],
		["['not-launched']", /requires a prior/],
		["Array.from({ length: 65 }, (_, i) => 'child-' + i)", /at most 64/],
		["[, 'api']", /key must be/],
		["[{ key: 'api', path: '/tmp/handoff.json' }]", /key must be/],
	] as const) it(`rejects an invalid selection: ${expression}`, async () => {
		let launched = false;
		await assert.rejects(runWorkflowScript({
			script: `return await runs.worktreeChanges(${expression});`,
			async launch(key) { launched = true; return { key, ok: true, output: "", artifactPaths: [] }; }, status: noStatus,
		}), error);
		assert.equal(launched, false);
	});

	it("validates every selected key before reading the first handoff", async (t) => {
		const { child } = fixture(t);
		const value = child("api", ["api.ts"]);
		const fsCjs = createRequire(import.meta.url)("node:fs") as typeof fs;
		const original = fsCjs.statSync;
		let reads = 0;
		const mock = t.mock.method(fsCjs, "statSync", ((...args: Parameters<typeof fs.statSync>) => {
			if (args[0] === value.worktreeHandoff!.path) reads++;
			return Reflect.apply(original, fsCjs, args);
		}) as typeof fs.statSync);
		syncBuiltinESMExports();
		t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
		await assert.rejects(runWorkflowScript({
			script: `await runs.run("api", { agent: "worker", task: "API" }); return await runs.worktreeChanges(["api", "missing"]);`,
			async launch() { return value; }, status: noStatus,
		}), /requires a prior.*missing/);
		assert.equal(reads, 0);
	});

	it("returns an incomplete snapshot while a known child is still pending", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const result = await runWorkflowScript({
			script: `const pending = runs.run("pending", { agent: "worker", task: "Wait" }); const changes = await runs.worktreeChanges(["pending"]); await runs.steer("pending", "Release"); await pending; return changes;`,
			async launch(key) { await gate; return { key, ok: true, output: "Done", artifactPaths: [] }; },
			async steer(key) { release(); return { key, state: "delivered" }; }, status: noStatus,
		});
		const value = result.value as { state: string; children: Array<{ error: string }> };
		assert.equal(value.state, "incomplete");
		assert.match(value.children[0]?.error ?? "", /has not finished/);
	});

	it("keeps non-isolated and explicit async children unexamined", async () => {
		const result = await runWorkflowScript({
			script: `await runs.all([{ key: "shared", agent: "worker", task: "Shared" }, { key: "async-child", agent: "worker", task: "Async" }]); return await runs.worktreeChanges(["shared", "async-child"]);`,
			async launch(key) { return { key, ok: key === "shared", ...(key === "async-child" ? { state: "running" as const } : {}), output: "", artifactPaths: [] }; }, status: noStatus,
		});
		const value = result.value as { state: string; children: Array<{ error: string }> };
		assert.equal(value.state, "incomplete");
		assert.match(value.children[0]?.error ?? "", /no managed-worktree handoff/);
		assert.match(value.children[1]?.error ?? "", /has not finished/);
	});

	it("does not treat evidence inspection as awaiting a child launch", async () => {
		await assert.rejects(runWorkflowScript({
			script: `runs.run("ignored", { agent: "worker", task: "Work" }); await runs.worktreeChanges(["ignored"]); return "Done";`,
			async launch(key) { return { key, ok: true, output: "Done", artifactPaths: [] }; }, status: noStatus,
		}), /unawaited runs.run.*ignored/);
	});
});
