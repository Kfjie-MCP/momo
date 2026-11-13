import { loadConfig } from "./config.js";
import { listen } from "./server.js";
import { closeReviewStores, getReviewStore } from "./review-store.js";

const config = loadConfig();
getReviewStore(config.localReviewDbPath);
const httpServer = listen(config);

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down.`);
  httpServer.close((error) => {
    closeReviewStores();
    if (error) {
      console.error("Shutdown failed", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
