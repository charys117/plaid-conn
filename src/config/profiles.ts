import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const profileSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    displayName: z.string().min(1),
    environment: z.enum(["sandbox", "production"]),
    clientIdEnv: z.string().min(1).optional(),
    clientIdFile: z.string().min(1).optional(),
    secretEnv: z.string().min(1).optional(),
    secretFile: z.string().min(1).optional(),
    countryCodes: z.array(z.string().length(2)).min(1).default(["US"]),
    language: z.string().length(2).default("en"),
    redirectUri: z.string().url().optional(),
    daysRequested: z.number().int().min(1).max(730).default(730),
    enabled: z.boolean().default(true)
  })
  .superRefine((profile, context) => {
    if (Number(Boolean(profile.clientIdEnv)) + Number(Boolean(profile.clientIdFile)) !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of clientIdEnv or clientIdFile"
      });
    }
    if (Number(Boolean(profile.secretEnv)) + Number(Boolean(profile.secretFile)) !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of secretEnv or secretFile"
      });
    }
  });

const profilesFileSchema = z.object({
  profiles: z.array(profileSchema).min(1)
});

export type RuntimePlaidProfile = {
  key: string;
  displayName: string;
  environment: "sandbox" | "production";
  clientId: string;
  secret: string;
  countryCodes: string[];
  language: string;
  redirectUri?: string;
  daysRequested: number;
  enabled: boolean;
};

async function readCredential(
  envName: string | undefined,
  fileName: string | undefined,
  source: NodeJS.ProcessEnv
): Promise<string> {
  if (envName) {
    const value = source[envName];
    if (!value) throw new Error(`Missing credential environment variable: ${envName}`);
    return value.trim();
  }

  if (!fileName) throw new Error("Credential source is missing");
  return (await readFile(resolve(fileName), "utf8")).trim();
}

export async function loadPlaidProfiles(
  fileName: string,
  source: NodeJS.ProcessEnv = process.env
): Promise<RuntimePlaidProfile[]> {
  const raw = await readFile(resolve(fileName), "utf8");
  const config = profilesFileSchema.parse(JSON.parse(raw));
  const seen = new Set<string>();
  const profiles: RuntimePlaidProfile[] = [];

  for (const entry of config.profiles) {
    if (seen.has(entry.key)) {
      throw new Error(`Duplicate Plaid profile key: ${entry.key}`);
    }
    seen.add(entry.key);

    const clientId = await readCredential(
      entry.clientIdEnv,
      entry.clientIdFile,
      source
    );
    const secret = await readCredential(entry.secretEnv, entry.secretFile, source);
    if (
      entry.environment === "production" &&
      entry.redirectUri &&
      !entry.redirectUri.startsWith("https://")
    ) {
      throw new Error(
        `Production Plaid profile ${entry.key} must use an HTTPS redirectUri`
      );
    }
    profiles.push({
      key: entry.key,
      displayName: entry.displayName,
      environment: entry.environment,
      clientId,
      secret,
      countryCodes: entry.countryCodes,
      language: entry.language,
      ...(entry.redirectUri ? { redirectUri: entry.redirectUri } : {}),
      daysRequested: entry.daysRequested,
      enabled: entry.enabled
    });
  }

  return profiles;
}
