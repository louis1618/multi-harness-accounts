import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { StateSchema, type State } from "../shared/accounts.js";
export class AccountError extends Error {}

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AccountError("계정 디렉터리가 안전하지 않습니다.");
  await chmod(path, 0o700);
}

export async function atomicWrite(path: string, contents: string | Buffer) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class Store {
  readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) { this.root = resolve(root); }
  async read(): Promise<State> {
    await privateDirectory(this.root);
    try {
      const stored = JSON.parse(await readFile(join(this.root, "metadata.json"), "utf8"));
      // Version 1 contains the same account/session metadata and no usage history.
      if (stored.version === 1) stored.version = 2;
      return StateSchema.parse(stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return StateSchema.parse({});
      // Never reset corrupted metadata: it may be the only link to a conversation's home.
      throw new AccountError("계정 정보를 읽을 수 없습니다. metadata.json을 백업에서 복원하세요.");
    }
  }
  // ponytail: one runtime per daemon installation; add a cross-process lock before supporting duplicate installations.
  update<T>(change: (state: State) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      const result = await change(state);
      const validated = StateSchema.parse(state);
      await atomicWrite(join(this.root, "metadata.json"), JSON.stringify(validated, null, 2) + "\n");
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
