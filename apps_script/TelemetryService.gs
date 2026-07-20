// =============================================================================
// COST SIMULATION ENGINE – TELEMETRY SERVICE
// Repository: cost-simulation-engine
// Description: Lightweight observability layer for the P&L Simulator.
//              Captures usage events, performance metrics, and error logs.
//              Designed to be non‑blocking and safe for production.
// Runtime: Google Apps Script (V8)
// =============================================================================

// ---------------------------------------------------------------------------
// 1. PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Logs a user interaction or system event.
 *
 * @param {string} eventName - Descriptive event identifier (e.g., 'CACHE_HIT', 'SCENARIO_SAVED').
 * @param {Object} [metadata={}] - Arbitrary key-value pairs with event details.
 */
function logEvent(eventName, metadata = {}) {
  logToConsole_('INFO', eventName, metadata);
}

/**
 * Logs an error with full context for debugging.
 *
 * @param {string} errorCode - Internal error code (e.g., 'BIGQUERY_TIMEOUT').
 * @param {string} message - Error description.
 * @param {Object} [context={}] - Additional context (stack, user, etc.).
 */
function logError(errorCode, message, context = {}) {
  logToConsole_('ERROR', errorCode, { message, ...context });
}

/**
 * Logs performance metrics for latency-sensitive operations.
 *
 * @param {string} operation - Operation name (e.g., 'getExecutiveDashboard').
 * @param {number} durationMs - Execution time in milliseconds.
 * @param {Object} [metadata={}] - Additional data (status, cache hit/miss).
 */
function logPerformance(operation, durationMs, metadata = {}) {
  logToConsole_('PERFORMANCE', operation, { duration_ms: durationMs, ...metadata });
}

// ---------------------------------------------------------------------------
// 2. INTERNAL IMPLEMENTATION
// ---------------------------------------------------------------------------

/**
 * Formats and outputs a log entry to the Apps Script console (Stackdriver).
 * In production, this can be extended to write directly to a BigQuery
 * telemetry table (see /sql/telemetry_logs.sql).
 *
 * @private
 */
function logToConsole_(level, tag, payload) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level,
    tag: tag,
    ...payload
  };
  
  // Use console.log for INFO/PERF, console.error for ERROR to leverage
  // Google Cloud Logging severity levels.
  if (level === 'ERROR') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}