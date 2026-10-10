// Opt-in native CLI checks. Uses only a generated local marketplace and isolated homes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AccountManager } from "../.test-build/server/manager.js";
import { ExtensionManager } from "../.test-build/server/extensions.js";
const root = await mkdtemp(join(process.cwd(), ".extensions-native-"));
const manager = new AccountManager({ root: join(root, "accounts") });
const extensions = new ExtensionManager(manager);
const put = async (path, value) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
};
const wait = async (id) => {
  for (let n = 0; n < 300; n++) {
    const job = (await extensions.jobs({})).jobs.find((j) => j.id === id);
    if (["done", "error", "approval"].includes(job.status)) {
      assert.equal(job.status, "done", JSON.stringify(job));
      return;
    }
    await delay(100);
  }
  throw Error("Native extension operation timed out");
};
try {
  const market = join(root, "market"),
    plugin = join(market, "plugins/team-tools");
  await put(join(market, ".claude-plugin/marketplace.json"), {
    name: "paseo-test-market",
    owner: { name: "Paseo fixture" },
    plugins: [
      { name: "team-tools", source: "./plugins/team-tools", version: "1.0.0" },
    ],
  });
  await put(join(market, ".agents/plugins/marketplace.json"), {
    name: "paseo-test-market",
    plugins: [
      {
        name: "team-tools",
        source: { source: "local", path: "./plugins/team-tools" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });
  for (const folder of [".claude-plugin", ".codex-plugin"])
    await put(join(plugin, folder, "plugin.json"), {
      name: "team-tools",
      version: "1.0.0",
      description: "Offline test fixture",
    });
  await put(
    join(plugin, "skills/example/SKILL.md"),
    "---\nname: example\ndescription: Offline test data\n---\nTest data.",
  );
  for (const harness of ["claude", "codex"]) {
    const accounts = ["A", "B"].map((label) => ({
      id: randomUUID(),
      label,
      harness,
      createdAt: new Date().toISOString(),
    }));
    await manager.store.update((s) => {
      s.accounts.push(...accounts);
    });
    for (const a of accounts)
      await mkdir(manager.profile(a), { recursive: true });
    const target = (a) => ({
        harness,
        accountId: a.id,
        scope: "user",
        sessionId: null,
      }),
      [a, b] = accounts;
    await wait(
      (
        await extensions.mutate(
          target(a),
          "marketplace",
          "paseo-test-market",
          "install",
          market,
        )
      ).job.id,
    );
    await wait(
      (
        await extensions.mutate(
          target(a),
          "plugin",
          "team-tools@paseo-test-market",
          "install",
        )
      ).job.id,
    );
    const initial = await extensions.inventory(target(a));
    assert(
      initial.items
        .find((x) => x.kind === "plugin")
        .components.some((x) => x.includes("example")),
    );
    await extensions.common(target(a), [
      "marketplace:paseo-test-market",
      "plugin:team-tools@paseo-test-market",
    ]);
    const plan = await extensions.preview([target(b)]);
    await wait((await extensions.apply(plan.id, [])).job.id);
    assert(
      (await extensions.inventory(target(b))).items.some(
        (x) => x.key === "plugin:team-tools@paseo-test-market",
      ),
    );
    for (const action of ["disable", "enable", "update", "remove"]) {
      await wait(
        (
          await extensions.mutate(
            target(b),
            "plugin",
            "team-tools@paseo-test-market",
            action,
          )
        ).job.id,
      );
      const found = (await extensions.inventory(target(b))).items.find(
        (x) => x.kind === "plugin",
      );
      if (action === "disable" || action === "enable")
        assert.equal(found.enabled, action === "enable");
      if (action === "remove") assert(!found);
    }
    assert(
      (await extensions.inventory(target(a))).items.some(
        (x) => x.kind === "plugin",
      ),
    );
    console.log(
      `${harness}: native install, common apply, toggle, update, remove, isolation passed`,
    );
  }
} finally {
  extensions.dispose();
  manager.dispose();
  await rm(root, { recursive: true, force: true });
}
