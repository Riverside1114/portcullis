export { runProxy, ServerLaunchError } from "./proxy.js";
export type { ProxyOptions, ProxyOutcome, ProxyStreams } from "./proxy.js";

export { createLogger, isLogLevel, LOG_LEVELS } from "./logging.js";
export type { Logger, LoggerOptions, LogLevel } from "./logging.js";

export { classify, correlationKey, LineFramer, DEFAULT_MAX_LINE_BYTES } from "./protocol.js";
export type {
  ClassifiedMessage,
  JsonRpcError,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  MessageKind,
} from "./protocol.js";

export { Recorder, AUDIT_SCHEMA_VERSION, DEFAULT_MAX_PAYLOAD_BYTES } from "./recorder.js";
export type { AuditRecord, Direction, RecorderOptions } from "./recorder.js";

export { Session } from "./session.js";
export type { SessionOptions, UnansweredCall } from "./session.js";

export { createObserver } from "./observer.js";
export type { ObserverOptions } from "./observer.js";

export { portcullisHome, logsDir, logPathFor, runDir, slugify } from "./paths.js";
