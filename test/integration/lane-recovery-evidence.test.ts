import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createEventBus, events, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { available, installAsyncExecutionHooks, mockPi, tempDir, readAsyncPayload } from "../support/async-execution-fixture.ts";

type Stage = { state: string; ok?: boolean; runId?: string; resumability?: { state: string }; terminalOutcome?: unknown; recovery?: { reportPath: string; reportHash: string } };
type Value = { board: Array<{ state: string; stages: Stage[] }>; child: Stage };

describe("public lane recovery evidence", { skip: !available }, () => {
	installAsyncExecutionHooks();
	for (const async of [false, true]) for (const scenario of ["timeout", "unlaunched", "acceptance"] as const) {
		it(`preserves ${scenario} facts through the lane board (async=${async})`, async () => {
			const reportPath = path.join(tempDir, "implementation-report.md");
			const malformed = 'ACCEPTANCE_REPORT: {"criteriaSatisfied":true}';
			if (scenario === "timeout") mockPi.onCall({ matchArgIncludes: "Timed worker", output: "Partial checkpoint", hangUntilAbort: true });
			if (scenario === "acceptance") mockPi.onCall({ matchArgIncludes: "Write implementation report", output: "Report saved", writeFiles: [{ path: reportPath, content: malformed }], jsonl: [...events.completedWrite(reportPath, malformed), events.assistantMessage("Report saved")] });
			mockPi.onCall({ matchArgIncludes: "Finished sibling", output: "Finished sibling report" });
			const stageParams = scenario === "timeout" ? { agent: "worker", task: "Timed worker", timeoutMs: 150, acceptance: false } :
				scenario === "acceptance" ? { agent: "worker", task: "Write implementation report", output: reportPath, outputMode: "file-only", acceptance: { level: "checked", criteria: ["Return the implementation report"] } } :
					{ agent: "missing-worker", task: "Not launched" };
			const executor = createSubagentExecutor({
				pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {}, asyncByDefault: false, tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => tempDir, expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("worker", { tools: ["read", "write"] })] }),
			});
			const result = await executor.executePublic(`lane-recovery-${scenario}-${async}`, {
				workflowScript: `
					const board = await runs.lanes([
						{ key: "work", stages: [{ key: "write", ...args.stage }, { key: "review", agent: "worker", task: "Must be skipped" }] },
						{ key: "sibling", stages: [{ key: "inspect", agent: "worker", task: "Finished sibling", acceptance: false }] }
					]);
					const [child] = await runs.all([{ key: "work.write", ...args.stage }]);
					return { board, child };
				`,
				args: { stage: stageParams }, async,
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.notEqual(result.isError, true, JSON.stringify(result));
			const payload = async ? await readAsyncPayload(result.details.asyncId!) : result.details;
			const value = payload.workflow!.value as Value;
			assert.equal(value.board[0]!.state, "blocked");
			assert.equal(value.board[0]!.stages[1]!.state, "skipped");
			assert.equal(value.board[1]!.state, "complete");
			const projected = value.board[0]!.stages[0]!;
			assert.equal(projected.ok, false);
			assert.equal(projected.runId, value.child.runId);
			assert.deepEqual(projected.resumability, value.child.resumability);
			assert.deepEqual(projected.terminalOutcome, value.child.terminalOutcome);
			assert.deepEqual(projected.recovery, value.child.recovery);
			if (scenario === "timeout") assert.deepEqual(projected.terminalOutcome, { state: "partial", reason: "timeout" });
			if (scenario === "acceptance") {
				assert.equal(projected.recovery?.reportPath, reportPath);
				assert.match(projected.recovery?.reportHash ?? "", /^[a-f0-9]{64}$/);
				assert.equal(fs.readFileSync(reportPath, "utf8"), malformed);
			}
			assert.equal(mockPi.sessions.length, scenario === "unlaunched" ? 1 : 2, "no implicit retry or skipped review may launch");
		});
	}
});
