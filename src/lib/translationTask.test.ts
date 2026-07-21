import { describe, expect, it } from "vitest";
import { TranslationTaskController } from "./translationTask";

describe("TranslationTaskController", () => {
  it("interrupts the active batch while paused and resumes with a fresh batch", async () => {
    const task = new TranslationTaskController();
    const firstBatch = task.startBatch();

    task.pause();

    expect(task.mode).toBe("paused");
    expect(firstBatch.aborted).toBe(true);
    expect(firstBatch.reason).toHaveProperty("name", "AbortError");

    const runnable = task.waitUntilRunnable();
    task.resume();

    await expect(runnable).resolves.toBe(true);
    expect(task.mode).toBe("running");
    expect(task.startBatch().aborted).toBe(false);
  });

  it("interrupts the active batch and releases a paused task when stopped", async () => {
    const task = new TranslationTaskController();
    const activeBatch = task.startBatch();
    task.pause();
    const runnable = task.waitUntilRunnable();

    task.stop();

    expect(activeBatch.aborted).toBe(true);
    expect(task.mode).toBe("stopped");
    await expect(runnable).resolves.toBe(false);
    await expect(task.waitUntilRunnable()).resolves.toBe(false);
    expect(task.startBatch().aborted).toBe(true);
  });
});
