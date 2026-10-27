import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { flattenSubagentToolOptions } from "../../src/extension/subagent-options.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { available, installAsyncExecutionHooks, mockPi, tempDir, readAsyncPayload } from "../support/async-execution-fixture.ts";

const script = fs.readFileSync(new URL("../../docs/recipes/evidence-review.js", import.meta.url), "utf8");
const finding = (severity = "P1") => ({ severity, claim: "A failed receipt is reported as success", location: "src/run.ts:42", evidence: "The return branch bypasses receipt validation." });
const inventory = (findings: unknown[] = []) => ({ status: "complete", coverage: "Read src/run.ts and its contract", findings });
type Report = { stage?: string; state: string; verdict: string; reviews: unknown[]; incompleteReviews: string[]; decisions: Array<{ id: string; disposition: string; evidence: string }> };

function makeRecipeExecutor(packaged = false) {
	return createSubagentExecutor({
		pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} },
		state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
		config: {}, asyncByDefault: false, tempArtifactsDir: tempDir,
		getSubagentSessionRoot: () => tempDir, expandTilde: (value: string) => value,
		discoverAgents: () => packaged
			? discoverAgents(tempDir, "both", undefined, { globalNpmRoot: path.join(tempDir, "absent-global-packages") })
			: ({ agents: [makeAgent("reviewer", { tools: ["read", "grep", "find", "ls"] })] }),
	});
}

describe("public evidence review recipe", { skip: !available }, () => {
	installAsyncExecutionHooks();
	for (const async of [false, true]) for (const scenario of ["packaged", "spawn-budget", "usage-budget"] as const) {
		it(`keeps the packaged reviewer contract and evidence on ${scenario} (async=${async})`, async () => {
			fs.mkdirSync(path.join(tempDir, "workflows"), { recursive: true });
			fs.writeFileSync(path.join(tempDir, "workflows/evidence-review.js"), script);
			mockPi.onCall({ matchArgIncludes: "Review angle: First", output: "Counted first review", structuredOutput: inventory([finding()]) });
			mockPi.onCall({ matchArgIncludes: "Review angle: Second", structuredOutput: inventory() });
			mockPi.onCall({ matchArgIncludes: '"id":"review-1.1"', structuredOutput: { disposition: "valid", evidence: "Independent source proof." } });
			const result = await makeRecipeExecutor(true).executePublic(`contract-${scenario}-${async}`, flattenSubagentToolOptions({
				workflow: "./workflows/evidence-review.js", args: { target: "src/run.ts", angles: ["First", "Second"] }, async,
				options: { globalConcurrencyLimit: 1, ...(scenario === "spawn-budget" ? { maxSubagentSpawnsPerRun: 2 } : {}), ...(scenario === "usage-budget" ? { usageBudget: { tokens: { hard: 1 } } } : {}) },
			}), new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			const payload = async ? await readAsyncPayload(result.details.asyncId!) : result.details;
			const success = async ? (payload as { success: boolean }).success : !result.isError;
			const workflow = payload.workflow as { value?: Report; emits: Report[]; receipt?: { entries: Record<string, { resolvedContext?: string }> } };
			assert.equal(success, scenario === "packaged");
			assert.equal(workflow.emits.length, 2);
			if (scenario === "packaged") {
				assert.equal(workflow.value?.verdict, "attention");
				const receipt = async ? (payload as unknown as { workflowReceipt: { receipt: NonNullable<typeof workflow.receipt> } }).workflowReceipt.receipt : workflow.receipt!;
				assert.equal(Object.keys(receipt.entries).length, 3);
				for (const child of Object.values(receipt.entries)) assert.equal(child.resolvedContext, "fresh");
				assert.equal(mockPi.sessions.length, 3);
				for (const session of mockPi.sessions) {
					assert.deepEqual([...(session.launch.tools ?? [])].sort(), ["read", "grep", "find", "ls", "watchdog_diff", "contact_supervisor", "structured_output"].sort());
					assert.equal(session.launch.ambientExtensions, false);
				}
			} else {
				assert.equal(mockPi.sessions.length, scenario === "spawn-budget" ? 2 : 1);
				const report = workflow.emits.at(-1)!;
				assert.equal(report.state, "incomplete");
				assert.equal(report.verdict, "incomplete");
				assert.equal(report.decisions.length, 1);
				const decision = report.decisions[0] as Report["decisions"][number] & { reason: string; verification: { ok: boolean; runId: string | null } };
				assert.equal(decision.id, "review-1.1");
				assert.equal(decision.evidence, finding().evidence);
				assert.equal(decision.disposition, "unresolved");
				assert.equal(decision.verification.ok, false);
				assert.equal(decision.verification.runId, null);
				assert.match(decision.reason, scenario === "spawn-budget" ? /fan-out|spawn/i : /usage budget/i);
			}
		});
	}
	for (const async of [false, true]) for (const scenario of ["minority", "cap", "missing-verifier", "invalid-review"] as const) {
		it(`retains review evidence for ${scenario} (async=${async})`, async (t) => {
			fs.mkdirSync(path.join(tempDir, "workflows"), { recursive: true });
			fs.writeFileSync(path.join(tempDir, "workflows/evidence-review.js"), script);
			const one = scenario === "cap" ? inventory([finding("P2")]) : inventory();
			const two = scenario === "invalid-review" ? inventory([finding("P9")]) : inventory([finding()]);
			mockPi.onCall({ matchArgIncludes: "Review angle: First", delay: 30, structuredOutput: one });
			mockPi.onCall({ matchArgIncludes: "Review angle: Second", delay: 30, ...(scenario === "invalid-review" ? {
				jsonl: [
					{ type: "tool_execution_start", toolName: "structured_output", args: { value: two } },
					{ type: "tool_execution_end", toolName: "structured_output", isError: true },
					{ type: "message_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output validation failed: severity P9" }], isError: true } },
				],
			} : { structuredOutput: two }) });
			mockPi.onCall({ matchArgIncludes: "Review angle: Third", delay: 30, structuredOutput: inventory() });
			if (scenario !== "invalid-review") mockPi.onCall({
				matchArgIncludes: '"id":"review-2.1"',
				...(scenario === "missing-verifier" ? { output: "Could not finish the check" } :
					{ structuredOutput: { disposition: "valid", evidence: "src/run.ts:42 returns before checking receipt state." } }),
			});
			const executor = makeRecipeExecutor();
			let maxActive = 0;
			const sampleActive = () => { maxActive = Math.max(maxActive, mockPi.sessions.filter(session => !session.settled && !session.disposed).length); };
			const sampler = setInterval(sampleActive, 1);
			t.after(() => clearInterval(sampler));
			const result = await executor.executePublic(`evidence-${scenario}-${async}`, flattenSubagentToolOptions({
				workflow: "./workflows/evidence-review.js",
				args: { target: "src/run.ts and supplied diff", angles: ["First", "Second", "Third"], maxVerifications: 1 },
				async, options: { globalConcurrencyLimit: 2 },
			}), new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			let workflow: { value?: Report; emits: Report[] };
			let success: boolean;
			if (async) {
				assert.ok(result.details.asyncId, JSON.stringify(result));
				const payload = await readAsyncPayload(result.details.asyncId);
				workflow = payload.workflow as typeof workflow;
				success = payload.success;
			} else {
				workflow = result.details.workflow as unknown as typeof workflow;
				success = !result.isError;
			}
			assert.equal(success, scenario === "minority", JSON.stringify(workflow));
			clearInterval(sampler);
			assert.equal(maxActive, 2, "workflow concurrency must cap active children across both passes");
			assert.equal(workflow.emits.length, 2);
			const report = workflow.value ?? workflow.emits.at(-1)!;
			assert.equal(report.state, success ? "complete" : "incomplete");
			assert.equal(report.reviews.length, 3);
			if (scenario === "invalid-review") {
				assert.deepEqual(report.incompleteReviews, ["review-2"]);
				assert.deepEqual(report.decisions, []);
			} else {
				const checked = report.decisions.find(item => item.id === "review-2.1")!;
				assert.equal(checked.disposition, scenario === "missing-verifier" ? "unresolved" : "valid");
				assert.equal(checked.evidence, finding().evidence);
				if (scenario === "cap") assert.equal(report.decisions[0]?.disposition, "deferred");
			}
			// A structured-output correction turn can prompt the same child again.
			// The recipe bounds child launches, not model turns.
			assert.equal(mockPi.sessions.length, scenario === "invalid-review" ? 3 : 4);
		});
	}
});
