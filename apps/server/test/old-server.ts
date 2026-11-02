import { Server } from "@hocuspocus/server";

/** A sync server from before the journal: its parseDocName has no journal documents, so it refuses them. */
export async function startOldServer() {
  const server = new Server({
    address: "127.0.0.1",
    port: 0,
    quiet: true,
    stopOnSignals: false,
    yDocOptions: { gc: false, gcFilter: () => false },
    async onAuthenticate({ documentName }) {
      if (documentName.includes("/journal/")) throw new Error(`invalid document name: ${documentName}`);
    },
  });
  await server.listen();
  return { url: `ws://127.0.0.1:${server.address.port}`, close: () => server.destroy() };
}
