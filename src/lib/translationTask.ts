export type TranslationTaskMode = "running" | "paused" | "stopped";

/** Coordinates pause, resume, and stop requests with the active translation batch. */
export class TranslationTaskController {
  private currentMode: TranslationTaskMode = "running";
  private activeBatch?: AbortController;
  private pausedWaiter?: (shouldContinue: boolean) => void;

  get mode(): TranslationTaskMode {
    return this.currentMode;
  }

  pause(): void {
    if (this.currentMode !== "running") return;
    this.currentMode = "paused";
    this.interruptActiveBatch("翻訳を一時停止しました。");
  }

  resume(): void {
    if (this.currentMode !== "paused") return;
    this.currentMode = "running";
    this.releaseWaiter(true);
  }

  stop(): void {
    if (this.currentMode === "stopped") return;
    this.currentMode = "stopped";
    this.interruptActiveBatch("翻訳を終了しました。");
    this.releaseWaiter(false);
  }

  waitUntilRunnable(): Promise<boolean> {
    if (this.currentMode === "running") return Promise.resolve(true);
    if (this.currentMode === "stopped") return Promise.resolve(false);

    return new Promise((resolve) => {
      this.pausedWaiter = resolve;
    });
  }

  startBatch(): AbortSignal {
    const batch = new AbortController();
    this.activeBatch = batch;
    if (this.currentMode !== "running") {
      batch.abort(new DOMException("翻訳処理は実行中ではありません。", "AbortError"));
    }
    return batch.signal;
  }

  finishBatch(signal: AbortSignal): void {
    if (this.activeBatch?.signal === signal) this.activeBatch = undefined;
  }

  private interruptActiveBatch(message: string): void {
    this.activeBatch?.abort(new DOMException(message, "AbortError"));
    this.activeBatch = undefined;
  }

  private releaseWaiter(shouldContinue: boolean): void {
    const waiter = this.pausedWaiter;
    this.pausedWaiter = undefined;
    waiter?.(shouldContinue);
  }
}
