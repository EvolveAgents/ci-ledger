import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** JSON files on disk under <root>/<owner>/<repo>/. Writes are atomic so an interrupted fetch can resume. */
export class Cache {
  readonly dir: string;

  constructor(root: string, owner: string, repo: string) {
    this.dir = join(root, owner, repo);
  }

  path(rel: string): string {
    return join(this.dir, rel);
  }

  has(rel: string): boolean {
    return existsSync(this.path(rel));
  }

  read<T>(rel: string): T | undefined {
    const file = this.path(rel);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }

  remove(rel: string): void {
    rmSync(this.path(rel), { force: true });
  }

  write(rel: string, data: unknown): void {
    const file = this.path(rel);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
    renameSync(tmp, file);
  }
}
