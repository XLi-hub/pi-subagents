import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { WorktreeOverlapReport } from "../../src/workflows/worktree-overlaps.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { installAsyncExecutionHooks, available, createSubagentExecutor, mockPi, tempDir, createRepo, readAsyncPayload, ASYNC_DIR } from "../support/async-execution-fixture.ts";

describe("workflow worktree overlap results", { skip: !available }, () => {
	installAsyncExecutionHooks();
	for (const background of [false, true]) {
		for (const outcome of ["overlap", "disjoint", "failure"] as const) {
			it(`reports captured child changes at completion (${outcome}, async=${background})`, async () => {
				const repo = createRepo("pi-workflow-overlap-");
				const secondFile = outcome === "disjoint" ? "ui.ts" : "shared.ts";
				mockPi.onCall({ matchArgIncludes: "API changes", output: "API ready", writeFiles: [{ path: "shared.ts", content: "export const api = true;\n" }] });
				mockPi.onCall({ matchArgIncludes: "UI changes", output: "UI ready", writeFiles: [{ path: secondFile, content: "export const ui = true;\n" }] });
				const executor = createSubagentExecutor!({
					pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} },
					state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
					config: { worktreeProvider: "native" }, asyncByDefault: false, tempArtifactsDir: tempDir,
					getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
					discoverAgents: () => ({ agents: [makeAgent("worker")] }),
				});
				try {
					const script = `const children = await runs.all([
						{ key: "api", agent: "worker", task: "API changes", cwd: ${JSON.stringify(repo)}, async: false },
						{ key: "ui", agent: "worker", task: "UI changes", cwd: ${JSON.stringify(repo)}, async: false }
					]); if (children.some(child => !child.ok)) throw new Error(children.map(child => child.error).join("; "));
					${outcome === "failure" ? 'throw new Error("Synthesis failed after child patches were captured");' : 'return children.map(child => child.key);'}`;
					const result = await executor.executePublic(`overlap-${outcome}-${background}`, {
						workflowScript: script, async: background, worktree: true, output: false, mission: false, acceptance: false,
					}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
					const payload = background ? await readAsyncPayload(result.details.asyncId!) as unknown as {
						workflow: { worktreeOverlaps?: WorktreeOverlapReport }; summary: string; success: boolean;
					} : undefined;
					const report = background ? payload!.workflow.worktreeOverlaps : result.details.workflow?.worktreeOverlaps;
					const text = background ? payload!.summary : result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
					assert.ok(report, text);
					assert.equal(report.state, "complete", JSON.stringify(report));
					assert.deepEqual(report.children.map((child) => child.key), ["api", "ui"]);
					assert.deepEqual(report.children.map((child) => child.paths), [["shared.ts"], [secondFile]]);
					assert.equal(report.overlaps.length, outcome === "disjoint" ? 0 : 1);
					if (outcome !== "disjoint") {
						assert.deepEqual(report.overlaps[0]?.children, ["api", "ui"]);
						assert.match(text, /shared\.ts/);
						assert.match(text, /file overlap does not establish a merge conflict/);
					}
					assert.match(text, /Worktree file overlap analysis: complete/);
					assert.equal(background ? payload!.success : result.isError !== true, outcome !== "failure");
					for (const child of report.children) {
						assert.ok(fs.existsSync(child.handoffPath));
						assert.ok(fs.existsSync(child.patchPath!));
						assert.match(fs.readFileSync(child.patchPath!, "utf8"), /export const/);
					}
					assert.equal(fs.existsSync(path.join(repo, "shared.ts")), false);
					if (background) {
						const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, result.details.asyncId!, "status.json"), "utf8"));
						assert.deepEqual(status.workflow.worktreeOverlaps, report);
					}
				} finally {
					fs.rmSync(repo, { recursive: true, force: true });
					fs.rmSync(path.join(path.dirname(repo), "worktrees", path.basename(repo)), { recursive: true, force: true });
				}
			});
		}
	}
});
