import { join } from "node:path";
import type { RequestLogEntry } from "./request-logging";
import {
  LocalJsonlStore,
  type JsonlStore,
  type StoredJsonlEntry,
} from "./jsonl-store";

export type StoredRequestLogEntry = StoredJsonlEntry<RequestLogEntry>;

export type RequestLogStore = JsonlStore<RequestLogEntry>;

export function getDefaultRequestLogDir(cwd = process.cwd()) {
  return join(cwd, ".web-providers", "request-logs");
}

export class LocalRequestLogStore
  extends LocalJsonlStore<RequestLogEntry>
  implements RequestLogStore {
  constructor(input: { scope: string; dir?: string }) {
    super({
      scope: input.scope,
      dir: input.dir ?? getDefaultRequestLogDir(),
    });
  }
}
