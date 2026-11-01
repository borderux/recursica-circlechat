// Fork: the api and the worker must share one file store. The api serves every
// stored file; the worker writes agents' deliverables (a long reply saved as
// reply.md, a file shared to a task). Observed: STORAGE_DIR was a folder inside
// each container, so a deliverable the worker saved was a 404 in the api, and
// every stored file was lost when the containers were recreated.
//
// Each process writes a probe file with a fresh id and puts the same id in
// Redis. The api reads the worker's probe from its own store: the same id means
// the store is shared. /health reports the verdict.
import { randomBytes } from "node:crypto";
import { readObject, putObject } from "./storage.js";
import { redis } from "./redis.js";

export type StorageVerdict = "shared" | "not_shared" | "unknown";

const probeKey = (service: string) => `.probe/${service}`;
const redisKey = (service: string) => `cc:storage-probe:${service}`;

// <announced>: the id the other process put in Redis; <onDisk>: what this
// process finds in its own store under that process's probe.
export function storageVerdict(announced: string | null, onDisk: string | null): StorageVerdict {
  if (!announced) return "unknown";
  return onDisk?.trim() === announced ? "shared" : "not_shared";
}

export async function writeStorageProbe(service: "api" | "worker"): Promise<void> {
  const id = randomBytes(8).toString("hex");
  await putObject(probeKey(service), Buffer.from(id));
  await redis.set(redisKey(service), id);
}

// Whether the worker's files are visible to this process.
export async function workerStorageVerdict(): Promise<StorageVerdict> {
  const announced = await redis.get(redisKey("worker")).catch(() => null);
  const onDisk = (await readObject(probeKey("worker")))?.toString("utf8") ?? null;
  return storageVerdict(announced, onDisk);
}
