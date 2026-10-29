import { readFileSync } from "node:fs";
import { agentIdSchema, parseAgentName, type AgentId } from "@provenance/core";
import { z } from "zod";

const tokenSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("device"), name: z.string().min(1), token: z.string().min(16) }),
  z.object({
    role: z.literal("agent"),
    name: z.string().min(1),
    token: z.string().min(16),
    /** Pin the identity (a personal agent like agent:andy); omit to let the client name itself. */
    agent: agentIdSchema.optional(),
  }),
]);

const configSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().default(8787),
  dataDir: z.string().default("./data"),
  maxBlobBytes: z.number().int().positive().default(100 * 1024 * 1024),
  tokens: z.array(tokenSchema).min(1),
});

export type Config = z.output<typeof configSchema>;
export type Credential = z.output<typeof tokenSchema>;

export function parseConfig(raw: unknown): Config {
  return configSchema.parse(raw);
}

export function loadConfig(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function credentialFor(config: Config, token: string | undefined | null): Credential | null {
  return (token && config.tokens.find((t) => t.token === token)) || null;
}

export function agentFor(cred: Credential, requested: string | null): AgentId | null {
  if (cred.role !== "agent") return null;
  return cred.agent ?? parseAgentName(requested);
}
