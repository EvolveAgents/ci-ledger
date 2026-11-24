import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../../src/collect/index.js";
import { defaultConfig, type Config } from "../../src/config.js";
import { fakeGitHub, type FakeOptions } from "../../src/fixtures/fake-github.js";
import { buildWorld } from "../../src/fixtures/synthetic.js";
import type { Dataset } from "../../src/types.js";

const cache = new Map<string, Promise<Dataset>>();

/** The synthetic dataset, collected once per option set and shared by tests. */
export function syntheticDataset(options: FakeOptions = {}, config: Config = defaultConfig()): Promise<Dataset> {
  const key = JSON.stringify(options);
  let p = cache.get(key);
  if (!p) {
    const world = buildWorld();
    p = collect({
      repo: "example-org/widgets",
      window: { since: world.since, until: world.until },
      config,
      now: world.now,
      cacheDir: mkdtempSync(join(tmpdir(), "ci-ledger-ds-")),
      fetch: fakeGitHub(world, options),
      token: "t",
    });
    cache.set(key, p);
  }
  return p;
}
