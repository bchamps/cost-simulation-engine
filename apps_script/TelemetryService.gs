// =============================================================================
// COST SIMULATION ENGINE – TELEMETRY SERVICE
// Repository: cost-simulation-engine
// Description: Enterprise-grade observability layer for the P&L Simulator.
//              Features in-memory buffering, distributed tracing (trace_id),
//              PII/secret sanitization, and Stackdriver integration.
// Runtime: Google Apps Script (V8)
// =============================================================================

const TelemetryService = (() => {
  // ---------------------------------------------------------------------------
  // 1. PRIVATE STATE & CONFIGURATION
  // ---------------------------------------------------------------------------
  const CONFIG_ = {
    MAX_BUFFER_SIZE: 50,
    SENSITIVE_KEYS: [
      'password', 'secret', 'token', 'api_key', 'apikey', 
      'authorization', 'credit_card', 'cpf', 'ssn', 'gemini_api_key'
    ]
  };

  const logBuffer_ = [];
  // Generates a unique RFC 4122 UUID for end-to-end execution tracing
  const TRACE_ID = Utilities.getUuid(); 

  // ---------------------------------------------------------------------------
  // 2. PRIVATE HELPER METHODS
  // ---------------------------------------------------------------------------

  /**
   * Recursively sanitizes payloads to strip out sensitive data (PII/Secrets).
   * Prevents accidental leakage of tokens or credentials into log sinks.
   *
   * @private
   * @param {*} obj - The payload to sanitize.
   * @returns {*} The sanitized payload.
   */
  function sanitizeObject_(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => sanitizeObject_(item));
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = CONFIG_.SENSITIVE_KEYS.some(sensitive => lowerKey.includes(sensitive));
      
      if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeObject_(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /**
   * Pushes an enriched log entry to the in-memory buffer.
   * Automatically triggers a flush if the buffer threshold is breached.
   *
   * @private
   */
  function emitLog_(level, tag, payload) {
    const entry = {
      timestamp: new Date().toISOString(),
      trace_id: TRACE_ID,
      level: level,
      tag: tag,
      ...sanitizeObject_(payload)
    };

    logBuffer_.push(entry);

    // Auto-flush defensive mechanism to prevent memory exhaustion
    if (logBuffer_.length >= CONFIG_.MAX_BUFFER_SIZE) {
      flush();
    }
  }

  // ---------------------------------------------------------------------------
  // 3. PUBLIC API METHODS
  // ---------------------------------------------------------------------------

  /**
   * Logs a user interaction or system event.
   *
   * @param {string} eventName - Descriptive event identifier (e.g., 'CACHE_HIT', 'SCENARIO_SAVED').
   * @param {Object} [metadata={}] - Arbitrary key-value pairs with event details.
   */
  function logEvent(eventName, metadata = {}) {
    emitLog_('INFO', eventName, metadata);
  }

  /**
   * Logs an error with full context for debugging and observability.
   * Seamlessly handles native JavaScript Error objects or raw strings.
   *
   * @param {string} errorCode - Internal error code or identifier.
   * @param {string|Error} errorInput - Error description or native Error instance.
   * @param {Object} [context={}] - Additional context (user, action, etc.).
   */
  function logError(errorCode, errorInput, context = {}) {
    let message = errorInput;
    let stack = '';

    if (errorInput instanceof Error) {
      message = errorInput.message;
      stack = errorInput.stack || '';
    }

    emitLog_('ERROR', errorCode, { message, stack, ...context });
  }

  /**
   * Logs performance metrics for latency-sensitive operations.
   *
   * @param {string} operation - Operation name (e.g., 'getExecutiveDashboard').
   * @param {number} durationMs - Execution time in milliseconds.
   * @param {Object} [metadata={}] - Additional data (status, cache hit/miss).
   */
  function logPerformance(operation, durationMs, metadata = {}) {
    emitLog_('PERFORMANCE', operation, { duration_ms: durationMs, ...metadata });
  }

  /**
   * Retrieves the unique execution trace identifier for correlation across systems.
   *
   * @returns {string} The active Trace ID for the current execution context.
   */
  function getTraceId() {
    return TRACE_ID;
  }

  /**
   * Flushes all buffered logs to Stackdriver (Google Cloud Logging).
   * Guaranteed to be called during serverless teardown via the controller's finally block.
   * In advanced architectures, this method can execute a batch MERGE into BigQuery.
   *
   * @returns {number} Number of logs flushed from the buffer.
   */
  function flush() {
    if (logBuffer_.length === 0) return 0;

    const count = logBuffer_.length;
    
    // Process in-memory queue and emit structured JSON to Stackdriver
    while (logBuffer_.length > 0) {
      const entry = logBuffer_.shift();
      const logString = JSON.stringify(entry);
      
      if (entry.level === 'ERROR') {
        console.error(logString);
      } else {
        console.log(logString);
      }
    }

    return count;
  }

  // ---------------------------------------------------------------------------
  // 4. PUBLIC INTERFACE EXPORT
  // ---------------------------------------------------------------------------
  return {
    logEvent,
    logError,
    logPerformance,
    getTraceId,
    flush
  };
})();