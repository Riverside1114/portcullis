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

export { createGate, denialResponse, POLICY_DENIED_CODE, DEFAULT_MAX_MESSAGE_BYTES } from "./gate.js";
export type { GateOptions, GateStream, GateAction, DenialDetails } from "./gate.js";

export type { PolicyRuntime } from "./proxy.js";
export type { PolicyOutcome } from "./recorder.js";

export {
  loadPolicy,
  parsePolicy,
  describeRule,
  PolicyLoadError,
  PolicyEngine,
  PolicyError,
  compilePolicy,
  parseDuration,
  parseYaml,
  YamlError,
  compilePattern,
  compilePatterns,
  matchesAny,
  PatternError,
  lookup,
  formatDuration,
  POLICY_SCHEMA_VERSION,
} from "./policy/index.js";
export type {
  Policy,
  Rule,
  RateLimit,
  ArgMatcher,
  Verdict,
  Decision,
  Pattern,
  YamlValue,
  YamlMap,
} from "./policy/index.js";

export {
  Analyzer,
  AnalyzerUnavailable,
  annotateResult,
  INJECTION_NOTICE,
  DEFAULT_ANALYZER_TIMEOUT_MS,
} from "./analyzer.js";
export type { AnalyzerResult, AnalyzerFinding, AnalyzerOptions } from "./analyzer.js";
export type { InspectionOutcome } from "./recorder.js";
