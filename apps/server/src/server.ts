#!/usr/bin/env node
import { loadConfig } from "./config";
import { createApp } from "./app";

const path = process.env.PROVENANCE_CONFIG ?? process.argv[2];
if (!path) {
  console.error("usage: provenance-server <config.json>   (or set PROVENANCE_CONFIG)");
  process.exit(2);
}

const app = createApp(loadConfig(path));
const server = await app.listen();
console.log(`provenance server listening on ${server.httpURL}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
