import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { WorktreeOverlapReport } from "../../src/workflows/worktree-overlaps.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { available, createSubagentExecutor, installAsyncExecutionHooks, mockPi, tempDir, createRepo, readAsyncPayload } from "../support/async-execution-fixture.ts";

interface InspectionValue {
	changes: WorktreeOverlapReport;
	state?: string;
	reviewKeys?: string[];
}

describe("workflow-directed review of captured worktree changes", { skip: !available }, () => {
	installAsyncExecutionHooks();
	for (const background of [false, true]) {
		for (const scenario of ["overlap", "disjoint", "missing-evidence", "failed-with-patch"] as const) {
			it(`collects change evidence before launching the requested reviews (${scenario}, async=${background})`, async () => {
				const repo = createRepo("pi-workflow-inspection-");
				const firstPath = scenario === "disjoint" ? "api.ts" : "shared.ts";
				const secondPath = scenario === "disjoint" ? "ui.ts" : "shared.ts";
				mockPi.onCall({ matchArgIncludes: "API changes", output: "API ready", writeFiles: [{ path: firstPath, content: "export const api = true;\n" }] });
				if (scenario !== "missing-evidence") mockPi.onCall({ matchArgIncludes: "UI changes", output: "UI ready", ...(scenario === "failed-with-patch" ? { exitCode: 1, stderr: "Worker failed after capturing partial work" } : {}), writeFiles: [{ path: secondPath, content: "export const ui = true;\n" }] });
				const expectedReviews = scenario === "overlap" ? 1 : scenario === "disjoint" ? 2 : 0;
				for (let index = 0; index < expectedReviews; index++) mockPi.onCall({ matchArgIncludes: "INSPECTION-REVIEW", output: `Review ${index} completed` });
				const executor = createSubagentExecutor!({
					pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} },
					state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
					config: { worktreeProvider: "native" }, asyncByDefault: false, tempArtifactsDir: tempDir,
					getSubagentSessionRoot: () => tempDir, expandTilde: (value: string) => value,
					discoverAgents: () => ({ agents: [makeAgent("worker"), makeAgent("reviewer")] }),
				});
				try {
					const ctx = { ...makeMinimalCtx(tempDir), modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5-mini" }] } };
					const script = `
						const writers = await runs.all([
							{ key: "api", agent: "worker", task: "API changes", cwd: ${JSON.stringify(repo)}, worktree: true, async: false },
							{ key: "ui", agent: "worker", task: "UI changes", cwd: ${JSON.stringify(repo)}, worktree: true, async: false ${scenario === "missing-evidence" ? ', model: "missing/unknown-model"' : ""} }
						]);
						const changes = await runs.worktreeChanges(writers.map(child => child.key));
						if (writers.some(child => !child.ok) || changes.state !== "complete") { emit({ state: "blocked", changes }); throw new Error("Writing stage blocked; no reviews launched."); }
						const groups = [...changes.reviewGroups.map(group => group.children), ...changes.disjointChildren.map(key => [key])];
						const reviews = await runs.all(groups.map((keys, index) => ({
							key: "review-" + index, agent: "reviewer", cwd: ${JSON.stringify(repo)}, worktree: false, async: false,
							task: "INSPECTION-REVIEW: Read-only review of these captured patches. Return findings only. " + JSON.stringify(changes.children.filter(child => keys.includes(child.key)).map(child => ({ key: child.key, patchPath: child.patchPath, handoffPath: child.handoffPath })))
						})));
						return { changes, reviewKeys: reviews.map(child => child.key) };
					`;
					const result = await executor.executePublic(`inspect-${scenario}-${background}`, { workflowScript: script, async: background, output: false, mission: false, acceptance: false }, new AbortController().signal, undefined, ctx);
					const blocked = scenario === "missing-evidence" || scenario === "failed-with-patch";
					const payload = background ? await readAsyncPayload(result.details.asyncId!) as unknown as { success: boolean; workflow: { value?: InspectionValue; emits: InspectionValue[]; worktreeOverlaps?: WorktreeOverlapReport } } : undefined;
					assert.equal(background ? payload!.success : result.isError !== true, !blocked, JSON.stringify(result));
					const workflow = background ? payload!.workflow : result.details.workflow!;
					const value = (blocked ? workflow.emits[0] : workflow.value) as InspectionValue;
					assert.equal(value.changes.state, scenario === "missing-evidence" ? "incomplete" : "complete");
					assert.deepEqual(value.changes, workflow.worktreeOverlaps, "explicit inspection and automatic completion use the same evidence projection");
					const reviewCalls = mockPi.sessions.filter((session) => session.task?.includes("INSPECTION-REVIEW"));
					assert.equal(reviewCalls.length, expectedReviews);
					assert.equal(mockPi.sessions.length, scenario === "missing-evidence" ? 1 : 2 + expectedReviews);
					if (scenario === "missing-evidence") {
						assert.equal(value.state, "blocked");
						assert.match(value.changes.children[1]?.error ?? "", /returned no worktree handoff/);
					} else if (scenario === "failed-with-patch") {
						assert.equal(value.state, "blocked");
						assert.ok(fs.existsSync(value.changes.children[1]?.patchPath!));
						assert.match(fs.readFileSync(value.changes.children[1]!.patchPath!, "utf8"), /export const ui/);
					} else {
						assert.equal(value.reviewKeys?.length, expectedReviews);
						for (const child of value.changes.children) {
							assert.ok(fs.existsSync(child.patchPath!));
							assert.match(fs.readFileSync(child.patchPath!, "utf8"), /export const/);
							assert.ok(reviewCalls.some((session) => session.task?.includes(child.patchPath!)));
						}
						for (const session of reviewCalls) assert.equal(fs.realpathSync(session.launch.cwd), fs.realpathSync(repo));
					}
					assert.equal(fs.existsSync(path.join(repo, firstPath)), false);
				} finally {
					fs.rmSync(repo, { recursive: true, force: true });
					fs.rmSync(path.join(path.dirname(repo), "worktrees", path.basename(repo)), { recursive: true, force: true });
				}
			});
		}
	}
});
