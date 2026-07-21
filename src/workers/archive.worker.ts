/// <reference lib="webworker" />

import type { ArchiveWorkerRequest } from "../lib/archiveClient";
import { parseModJarFiles, parseModpackArchive } from "../lib/modArchive";

self.onmessage = (event: MessageEvent<ArchiveWorkerRequest>) => {
  try {
    const result = event.data.type === "modpack"
      ? parseModpackArchive(event.data.bytes)
      : parseModJarFiles(event.data.files);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
