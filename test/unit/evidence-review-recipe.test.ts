import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { runWorkflowScript, validateWorkflowScript, WorkflowScriptError, type WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";
import { validateStructuredOutputValue } from "../../src/runs/shared/structured-output.ts";

const script = fs.readFileSync(new URL("../../docs/recipes/evidence-review.js", import.meta.url), "utf8");
const args = { target: "supplied change.patch and src/", angles: ["Correctness", "Evidence", "Tests"] };
const finding = (severity = "P1", claim = "Missing failure evidence") => ({ severity, claim, location: "src/run.ts:42", evidence: "The failure path returns success without checking the receipt." });
const inventory = (findings: unknown[] = [], status = "complete") => ({ status, coverage: "Inspected the named target and contract", findings });
type Decision = { id: string; severity: string; claim: string; evidence: string; disposition: string; reason: string; verification: { ok: boolean; report: unknown } | null };
type Report = { state: string; verdict: string; reviews: Array<{ key: string; report: unknown }>; incompleteReviews: string[]; decisions: Decision[] };

async function execute(options: {
	args?: Record<string, unknown>;
	respond?: (key: string) => Partial<WorkflowScriptChildResult> | Promise<Partial<WorkflowScriptChildResult>>;
} = {}) {
	const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
	const snapshots: unknown[][] = [];
	try {
		const execution = await runWorkflowScript({
			script, args: options.args ?? args, timeoutMs: 5000, globalConcurrencyLimit: 4,
			onEmit: values => snapshots.push(values),
			async launch(key, params) {
				launches.push({ key, params });
				return { key, runId: "run-" + key, ok: true, output: "captured", artifactPaths: [],
					structuredOutput: key.startsWith("review-") ? inventory() : { disposition: "valid", evidence: "src/run.ts:42 proves the claim." },
					...await options.respond?.(key) };
			},
			async status() { throw new Error("Recipe must not poll status"); },
		});
		return { report: execution.value as Report, launches, snapshots, error: undefined };
	} catch (error) {
		assert.ok(error instanceof WorkflowScriptError);
		return { report: error.partial.emits.at(-1) as Report | undefined, launches, snapshots, error };
	}
}

describe("evidence review recipe", () => {
	it("validates as a portable workflow", () => {
		const validation = validateWorkflowScript(script);
		assert.equal(validation.ok, true, JSON.stringify(validation));
	});

	it("verifies a minority finding and preserves both pieces of evidence", async () => {
		const { report, launches, snapshots, error } = await execute({ respond: key => key === "review-2" ? { structuredOutput: inventory([finding()]) } : {} });
		assert.equal(error, undefined);
		assert.equal(report?.verdict, "attention");
		assert.deepEqual(launches.map(item => item.key), ["review-1", "review-2", "review-3", "verify-review-2.1"]);
		assert.equal(report?.decisions[0]?.id, "review-2.1");
		assert.equal(report?.decisions[0]?.evidence, finding().evidence);
		assert.match(report?.decisions[0]?.reason ?? "", /proves the claim/);
		assert.equal(snapshots[0]?.length, 1);
		assert.equal(snapshots.at(-1)?.length, 2);
		for (const { params } of launches) {
			assert.equal(params.context, "fresh");
			assert.equal(params.worktree, false);
			assert.equal(params.async, undefined);
			assert.ok(params.outputSchema);
		}
		assert.match(String(launches.at(-1)?.params.task), /supplied change.patch and src\//);
	});

	it("launches no verifiers for complete empty inventories", async () => {
		const { report, launches, error } = await execute();
		assert.equal(error, undefined);
		assert.equal(report?.verdict, "no-supported-findings");
		assert.equal(launches.length, 3);
	});

	it("requires bounded inventories and concrete evidence in both output schemas", async () => {
		const { launches } = await execute({ respond: key => key === "review-1" ? { structuredOutput: inventory([finding()]) } : {} });
		const reviewSchema = launches[0]!.params.outputSchema as Record<string, unknown>;
		const verificationSchema = launches.at(-1)!.params.outputSchema as Record<string, unknown>;
		for (const value of [inventory([finding("P9")]), inventory([finding(), finding(), finding(), finding()]), inventory([{ ...finding(), evidence: "" }]), inventory([{ ...finding(), evidence: " \n\t" }]), { ...inventory(), coverage: " " }]) {
			assert.equal((await validateStructuredOutputValue(reviewSchema, value)).status, "invalid");
		}
		for (const value of [{ disposition: "invalid", evidence: "" }, { disposition: "valid", evidence: " \n\t" }, { disposition: "clean", evidence: "claim" }, { disposition: "valid" }]) {
			assert.equal((await validateStructuredOutputValue(verificationSchema, value)).status, "invalid");
		}
		assert.equal((await validateStructuredOutputValue(reviewSchema, inventory([finding()]))).status, "valid");
		assert.equal((await validateStructuredOutputValue(verificationSchema, { disposition: "unresolved", evidence: "Need supervisor-run test" })).status, "valid");
	});

	it("prioritizes severity but retains original order and every deferred claim", async () => {
		const { report, launches, error } = await execute({
			args: { ...args, maxVerifications: 2 },
			respond: key => key === "review-1" ? { structuredOutput: inventory([finding("P2"), finding("P1"), finding("P0")]) } :
				key === "review-2" ? { structuredOutput: inventory([finding("P1")]) } : {},
		});
		assert.ok(error);
		assert.equal(report?.state, "incomplete");
		assert.deepEqual(launches.slice(3).map(item => item.key), ["verify-review-1.3", "verify-review-1.2"]);
		assert.deepEqual(report?.decisions.map(item => [item.id, item.disposition]), [
			["review-1.1", "deferred"], ["review-1.2", "valid"], ["review-1.3", "valid"], ["review-2.1", "deferred"],
		]);
	});

	it("allows a zero follow-up cap without presenting findings as clean", async () => {
		const { report, launches, error } = await execute({ args: { ...args, maxVerifications: 0 }, respond: key => key === "review-1" ? { structuredOutput: inventory([finding()]) } : {} });
		assert.ok(error);
		assert.equal(report?.decisions[0]?.disposition, "deferred");
		assert.equal(launches.length, 3);
	});

	it("retains supported P2 notes without upgrading their severity", async () => {
		const { report, error } = await execute({ respond: key => key === "review-1" ? { structuredOutput: inventory([finding("P2")]) } : {} });
		assert.equal(error, undefined);
		assert.equal(report?.verdict, "notes");
	});

	it("keeps invalid claims and their counterevidence inspectable", async () => {
		const { report, error } = await execute({ respond: key => key === "review-1" ? { structuredOutput: inventory([finding()]) } : key.startsWith("verify-") ? { structuredOutput: { disposition: "invalid", evidence: "src/run.ts:40 checks the receipt before returning." } } : {} });
		assert.equal(error, undefined);
		assert.equal(report?.verdict, "no-supported-findings");
		assert.equal(report?.decisions[0]?.claim, finding().claim);
		assert.match(report?.decisions[0]?.reason ?? "", /checks the receipt/);
	});

	for (const response of [
		{ structuredOutput: { disposition: "unresolved", evidence: "Needs a supervisor-run repro." } },
		{ ok: false, error: "provider failed", structuredOutput: { disposition: "invalid", evidence: "captured before failure" } },
		{ structuredOutput: null },
	]) it(`fails incomplete for unusable verification: ${JSON.stringify(response)}`, async () => {
		const { report, error } = await execute({ respond: key => key === "review-1" ? { structuredOutput: inventory([finding()]) } : key.startsWith("verify-") ? response : {} });
		assert.ok(error);
		assert.equal(report?.verdict, "incomplete");
		assert.equal(report?.decisions[0]?.disposition, "unresolved");
		assert.equal(report?.decisions[0]?.evidence, finding().evidence);
		assert.deepEqual(report?.decisions[0]?.verification?.report, response.structuredOutput);
	});

	it("retains failed first-pass evidence and still checks settled siblings", async () => {
		const captured = inventory([finding("P0")]);
		const { report, launches, error } = await execute({ respond: key => key === "review-1" ? { ok: false, error: "provider failure", structuredOutput: captured } : key === "review-3" ? { structuredOutput: inventory([finding()]) } : {} });
		assert.ok(error);
		assert.deepEqual(report?.incompleteReviews, ["review-1"]);
		assert.deepEqual(report?.reviews[0]?.report, captured);
		assert.equal(launches.at(-1)?.key, "verify-review-3.1");
		assert.equal(report?.decisions[0]?.disposition, "valid");
	});

	it("cannot pass when the initial inventory reports blocked or missing output", async () => {
		const { report, error } = await execute({ respond: key => key === "review-1" ? { structuredOutput: inventory([], "blocked") } : key === "review-2" ? { structuredOutput: null } : {} });
		assert.ok(error);
		assert.deepEqual(report?.incompleteReviews, ["review-1", "review-2"]);
	});

	it("supports all twelve verifications without dropping repeated claims", async () => {
		const { report, launches, error } = await execute({ args: { ...args, angles: ["A", "B", "C", "D"], maxVerifications: 12 }, respond: key => key.startsWith("review-") ? { structuredOutput: inventory([finding(), finding(), finding()]) } : {} });
		assert.equal(error, undefined);
		assert.equal(report?.decisions.length, 12);
		assert.equal(new Set(report?.decisions.map(item => item.id)).size, 12);
		assert.equal(launches.length, 16);
	});

	for (const invalid of [
		{ ...args, target: " " }, { ...args, target: "x".repeat(4001) },
		{ ...args, angles: [] }, { ...args, angles: ["same", " same "] },
		{ ...args, angles: ["A", "B", "C", "D", "E"] }, { ...args, angles: [42] },
		{ ...args, maxVerifications: -1 }, { ...args, maxVerifications: 13 }, { ...args, maxVerifications: 1.5 }, { ...args, maxVerifications: null },
	]) it(`rejects invalid args before launching: ${JSON.stringify(invalid).slice(0, 140)}`, async () => {
		const { error, launches } = await execute({ args: invalid });
		assert.ok(error);
		assert.equal(launches.length, 0);
	});
});
