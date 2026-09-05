/**
 * Library surface.
 *
 * Portcullis is primarily a command line tool, but the proxy is exported so it
 * can be embedded — an agent framework that spawns its own MCP servers can wrap
 * them in-process rather than shelling out.
 */

export { runProxy, ServerLaunchError } from "./proxy.js";
export type { ProxyOptions, ProxyOutcome, ProxyStreams } from "./proxy.js";

export { createLogger, isLogLevel, LOG_LEVELS } from "./logging.js";
export type { Logger, LoggerOptions, LogLevel } from "./logging.js";
