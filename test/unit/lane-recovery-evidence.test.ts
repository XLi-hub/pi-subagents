import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWorkflowScript, WorkflowScriptError, type WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";

type Stage = { key: string; state: string; ok?: boolean; runId?: string; resumability?: { state: string; reason?: string }; terminalOutcome?: { state: string; reason: string }; recovery?: { status: string; reason: string; reportPath: string; reportHash: string } };
type Lane = { key: string; state: string; failedStage?: string; stages: Stage[] };
const recovery = { status: "available-for-review" as const, reason: "acceptance-metadata-rejected" as const, reportPath: "/reports/rejected.json", reportHash: "a".repeat(64) };

async function board(results: Array<Partial<WorkflowScriptChildResult>>) {
	let launches = 0;
	const result = await runWorkflowScript({
		script: `return await runs.lanes(args.items.map((_, index) => ({ key: "lane-" + index, stages: [
			{ key: "write", agent: "worker", task: "Write" }, { key: "review", agent: "reviewer", acceptance: false, task: "Read-only review of captured evidence. Do not edit files." }
		] })));`,
		args: { items: results.map(() => null) },
		async launch(key) {
			launches++;
			return { key, ok: true, runId: "run-" + key, output: "report", artifactPaths: [],
				...(key.endsWith(".write") ? results[Number(key.split(".")[0]!.slice(5))] : {}) };
		},
		async status() { throw new Error("Lane board must not inspect status or sessions"); },
	});
	return { lanes: result.value as Lane[], launches, children: result.children };
}

describe("lane recovery evidence", () => {
	it("retains recovery facts for a failed lane while siblings keep advancing", async () => {
		const { lanes, launches } = await board([
			{ ok: false, error: "deadline", terminalOutcome: { state: "partial", reason: "timeout" }, resumability: { state: "resumable" }, recovery },
			{ ok: false, error: "budget", terminalOutcome: { state: "partial", reason: "budget_exhausted" }, resumability: { state: "not-resumable", reason: "session was not persisted" } },
			{ resumability: { state: "resumable" } },
		]);
		const timedOut = lanes[0]!.stages[0]!;
		assert.equal(lanes[0]!.state, "blocked");
		assert.equal(timedOut.ok, false);
		assert.deepEqual(timedOut.resumability, { state: "resumable" });
		assert.deepEqual(timedOut.terminalOutcome, { state: "partial", reason: "timeout" });
		assert.deepEqual(timedOut.recovery, recovery);
		assert.deepEqual(lanes[0]!.stages[1], { key: "review", state: "skipped" });
		assert.equal(lanes[1]!.stages[0]!.terminalOutcome?.reason, "budget_exhausted");
		assert.equal(lanes[1]!.stages[0]!.resumability?.reason, "session was not persisted");
		assert.equal(lanes[2]!.state, "complete");
		assert.equal(launches, 4, "metadata must not launch recovery children");
	});

	it("does not infer resumability from successful completion or a run id", async () => {
		const { lanes } = await board([{ ok: true }, { ok: false, error: "failed" }]);
		for (const lane of lanes) {
			assert.ok(lane.stages[0]!.runId);
			assert.equal(lane.stages[0]!.resumability, undefined);
			assert.equal(lane.stages[0]!.terminalOutcome, undefined);
		}
	});

	it("preserves the acceptance-recovery barrier after returning a lane board", async () => {
		let launches = 0;
		await assert.rejects(runWorkflowScript({
			script: `const board = await runs.lanes([{ key: "api", stages: [{ key: "write", agent: "worker", task: "Write" }] }]); emit(board); return await runs.run("retry", { agent: "worker", task: "Continue writing" });`,
			async launch(key) { launches++; return { key, ok: false, output: "rejected", artifactPaths: [], recovery }; },
			async status() { throw new Error("No status reads"); },
		}), (error: unknown) => {
			assert.ok(error instanceof WorkflowScriptError);
			assert.match(error.message, /acceptance|recovery/i);
			assert.deepEqual((error.partial.emits[0] as Lane[])[0]?.stages[0]?.recovery, recovery);
			return true;
		});
		assert.equal(launches, 1);
	});

	it("projects only bounded metadata rather than child transcripts or extra fields", async () => {
		const { lanes } = await board([{
			ok: false, error: "rejected", output: "large transcript".repeat(10000), structuredOutput: { secretToBoard: "large report" },
			resumability: { state: "not-resumable", reason: "原因".repeat(2000) }, recovery,
		}]);
		const stage = lanes[0]!.stages[0]!;
		assert.ok(Buffer.byteLength(stage.resumability!.reason!, "utf8") <= 256);
		assert.ok(JSON.stringify(stage).length < 2000);
		assert.equal("output" in stage, false);
		assert.equal("structuredOutput" in stage, false);
	});

	it("does not truncate identifiers or evidence paths into usable references", async () => {
		const { lanes } = await board([
			{ ok: false, runId: "x".repeat(257), resumability: { state: "resumable" }, recovery: { ...recovery, reportPath: "/" + "x".repeat(256) } },
			{ ok: false, runId: "x".repeat(256), resumability: { state: "resumable" }, recovery: { ...recovery, reportPath: "/" + "x".repeat(255) } },
		]);
		assert.equal(lanes[0]!.stages[0]!.runId, undefined);
		assert.equal(lanes[0]!.stages[0]!.resumability, undefined);
		assert.equal(lanes[0]!.stages[0]!.recovery, undefined);
		assert.equal(lanes[1]!.stages[0]!.runId?.length, 256);
		assert.equal(lanes[1]!.stages[0]!.resumability?.state, "resumable");
		assert.equal(lanes[1]!.stages[0]!.recovery?.reportPath.length, 256);
	});

	for (const state of ["running", "stopped", "detached"] as const) it(`does not advertise a ${state} child as resumable`, async () => {
		const flags = state === "running" ? { state: "running" as const } : { [state]: true };
		const { lanes, launches } = await board([{ ok: false, ...flags, resumability: { state: "resumable" } }]);
		assert.equal(lanes[0]!.stages[0]!.resumability, undefined);
		assert.equal(lanes[0]!.stages[1]!.state, "skipped");
		assert.equal(launches, 1);
	});

	it("omits malformed recovery metadata without upgrading the failed stage", async () => {
		const { lanes } = await board([{
			ok: false, resumability: { state: "not-resumable", reason: "" },
			terminalOutcome: { state: "partial", reason: "unexpected" } as never,
			recovery: { ...recovery, reportHash: "not-a-hash" },
		}]);
		const stage = lanes[0]!.stages[0]!;
		assert.equal(stage.state, "failed");
		assert.equal(stage.resumability, undefined);
		assert.equal(stage.terminalOutcome, undefined);
		assert.equal(stage.recovery, undefined);
	});

	it("lets scripts choose an explicit follow-up from recorded facts", async () => {
		const launches: Array<{ key: string; resume: unknown }> = [];
		const result = await runWorkflowScript({
			script: `
				const board = await runs.lanes([{ key: "api", stages: [{ key: "write", agent: "worker", task: "Write" }] }]);
				const stage = board[0].stages[0];
				if (stage.resumability?.state !== "resumable" || stage.terminalOutcome?.reason !== "timeout") return board;
				return await runs.run("api-recovery", { resume: stage.runId, task: "Inspect the partial result before continuing the approved scope" });
			`,
			async launch(key, params) {
				launches.push({ key, resume: params.resume });
				return key === "api.write" ? { key, ok: false, runId: "partial-api", output: "checkpoint", artifactPaths: [], resumability: { state: "resumable" }, terminalOutcome: { state: "partial", reason: "timeout" } } :
					{ key, ok: true, output: "continued", artifactPaths: [] };
			},
			async status() { throw new Error("No extra status reads"); },
		});
		assert.deepEqual(launches, [{ key: "api.write", resume: undefined }, { key: "api-recovery", resume: "partial-api" }]);
		assert.equal((result.value as { output: string }).output, "continued");
	});
});
