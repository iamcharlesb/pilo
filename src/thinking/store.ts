import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { ThinkingState, ThinkingStore } from "./types";

export class InMemoryThinkingStore implements ThinkingStore {
  private state?: ThinkingState;

  async load(): Promise<ThinkingState | undefined> {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async save(state: ThinkingState): Promise<void> {
    this.state = structuredClone(state);
  }
}

/** Atomic snapshots for a local, single-operator arena. Do not share a file between writers. */
export class FileThinkingStore implements ThinkingStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<ThinkingState | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf8")) as ThinkingState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: ThinkingState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    // Open exclusively before entering cleanup: a collision must never overwrite
    // or remove a file/symlink that this save did not create.
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(state, null, 2), "utf8");
      } finally { await file.close(); }
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
