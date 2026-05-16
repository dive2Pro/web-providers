import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoredJsonlEntry<TEntry extends Record<string, unknown>> extends TEntry {
  loggedAt: string;
}

export interface JsonlStore<TEntry extends Record<string, unknown>> {
  append(entry: TEntry): Promise<void>;
  list(input?: { limit?: number }): Promise<{
    filePath: string;
    logs: Array<StoredJsonlEntry<TEntry>>;
  }>;
}

export class LocalJsonlStore<TEntry extends Record<string, unknown>>
  implements JsonlStore<TEntry> {
  readonly filePath: string;

  constructor(input: { scope: string; dir: string }) {
    this.filePath = join(input.dir, `${input.scope}.ndjson`);
  }

  async append(entry: TEntry) {
    const record: StoredJsonlEntry<TEntry> = {
      ...entry,
      loggedAt: new Date().toISOString(),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async list(input?: { limit?: number }) {
    const limit = normalizeLimit(input?.limit);

    try {
      const content = await readFile(this.filePath, "utf8");
      const logs = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => safeParseJsonLine<TEntry>(line))
        .filter((entry): entry is StoredJsonlEntry<TEntry> => entry !== null)
        .slice(-limit)
        .reverse();

      return {
        filePath: this.filePath,
        logs,
      };
    } catch (error) {
      if (isFileMissingError(error)) {
        return {
          filePath: this.filePath,
          logs: [],
        };
      }

      throw error;
    }
  }
}

function normalizeLimit(limit?: number) {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return 100;
  }

  return Math.min(Math.trunc(limit), 1000);
}

function safeParseJsonLine<TEntry extends Record<string, unknown>>(line: string) {
  try {
    return JSON.parse(line) as StoredJsonlEntry<TEntry>;
  } catch {
    return null;
  }
}

function isFileMissingError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
