import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("container deployment", () => {
  it("defines only the connector services and keeps PostgreSQL internal", async () => {
    const compose = parse(
      await readFile(resolve("compose.yaml"), "utf8")
    ) as {
      services: Record<
        string,
        {
          command?: string[];
          ports?: string[];
          networks?: string[];
        }
      >;
    };

    expect(Object.keys(compose.services).sort()).toEqual([
      "app",
      "postgres",
      "worker"
    ]);
    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.app?.networks).toContain("internal");
    expect(compose.services.worker?.networks).toContain("internal");
    expect(compose.services.app?.command).toEqual([
      "node",
      "dist/server/server/index.js"
    ]);
    expect(compose.services.worker?.command).toEqual([
      "node",
      "dist/server/worker/index.js"
    ]);
  });

  it("uses the same verified server entrypoint in the runtime image", async () => {
    const dockerfile = await readFile(resolve("Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      'CMD ["node", "dist/server/server/index.js"]'
    );
    expect(dockerfile).not.toMatch(/grafana/i);
  });
});
