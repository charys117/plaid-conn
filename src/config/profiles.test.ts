import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlaidProfiles } from "./profiles";

describe("loadPlaidProfiles", () => {
  it("loads multiple profiles while resolving secrets from the environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plaid-profiles-"));
    const filename = join(directory, "profiles.json");
    await writeFile(
      filename,
      JSON.stringify({
        profiles: [
          {
            key: "primary",
            displayName: "Primary",
            environment: "sandbox",
            clientIdEnv: "PRIMARY_ID",
            secretEnv: "PRIMARY_SECRET",
            countryCodes: ["US"]
          },
          {
            key: "secondary",
            displayName: "Secondary",
            environment: "production",
            clientIdEnv: "SECONDARY_ID",
            secretEnv: "SECONDARY_SECRET",
            countryCodes: ["US", "CA"],
            daysRequested: 365
          }
        ]
      })
    );

    const profiles = await loadPlaidProfiles(filename, {
      PRIMARY_ID: "client-a",
      PRIMARY_SECRET: "secret-a",
      SECONDARY_ID: "client-b",
      SECONDARY_SECRET: "secret-b"
    });

    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toMatchObject({
      key: "primary",
      clientId: "client-a",
      secret: "secret-a",
      daysRequested: 730
    });
    expect(profiles[1]).toMatchObject({
      key: "secondary",
      environment: "production",
      countryCodes: ["US", "CA"],
      daysRequested: 365
    });
  });

  it("rejects duplicate profile keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plaid-profiles-"));
    const filename = join(directory, "profiles.json");
    const profile = {
      key: "duplicate",
      displayName: "Duplicate",
      environment: "sandbox",
      clientIdEnv: "ID",
      secretEnv: "SECRET"
    };
    await writeFile(
      filename,
      JSON.stringify({ profiles: [profile, profile] })
    );

    await expect(
      loadPlaidProfiles(filename, { ID: "id", SECRET: "secret" })
    ).rejects.toThrow(/Duplicate/);
  });
});
