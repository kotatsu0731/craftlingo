import type { ParsedModpack } from "./modArchive";

export interface JarFileInput {
  path: string;
  bytes: ArrayBuffer;
}

export type ArchiveWorkerRequest =
  | { type: "modpack"; bytes: ArrayBuffer }
  | { type: "jars"; files: JarFileInput[] };

interface WorkerResponse {
  result?: ParsedModpack;
  error?: string;
}

function requestArchiveParse(request: ArchiveWorkerRequest): Promise<ParsedModpack> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/archive.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      worker.terminate();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "入力ファイルの解析に失敗しました。"));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "解析Workerを起動できませんでした。"));
    };
    const transfers = request.type === "modpack"
      ? [request.bytes]
      : request.files.map((file) => file.bytes);
    worker.postMessage(request, transfers);
  });
}

/** Parse the legacy ZIP modpack input. */
export function parseArchiveInWorker(input: ArrayBuffer): Promise<ParsedModpack> {
  return requestArchiveParse({ type: "modpack", bytes: input });
}

/** Parse directly selected JARs while preserving their relative paths. */
export function parseJarFilesInWorker(files: JarFileInput[]): Promise<ParsedModpack> {
  return requestArchiveParse({ type: "jars", files });
}
