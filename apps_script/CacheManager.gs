/**
 * =============================================================================
 * COST SIMULATION ENGINE – CACHE MANAGER
 * Repository: cost-simulation-engine
 * Architecture: Serverless Caching Layer with Automated Payload Sharding
 * Description: Mitigates BigQuery scan costs and UI latency. Bypasses the GAS
 *              100 KB cache limit via automated string chunking/sharding.
 *              Supports global (Script) and isolated (User) caching scopes.
 * Runtime: Google Apps Script (V8 Engine)
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// 1. CONSTANTS & CONFIGURATION
// ---------------------------------------------------------------------------

const CACHE_CONFIG = {
  DEFAULT_TTL: CONFIG.CACHE_TTL || 21600, // 6 hours max in GAS
  CHUNK_SIZE: 90000,                      // 90 KB safe threshold (GAS limit is 100 KB)
  SHARD_PREFIX: 'SHARD_META::'            // Header identifier for chunked payloads
};

// ---------------------------------------------------------------------------
// 2. PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Retrieves and deserializes a cached value by key.
 * Automatically detects and reassembles sharded (chunked) payloads > 100 KB.
 *
 * @param {string} key - Unique cache identifier.
 * @param {string} [scope='SCRIPT'] - 'SCRIPT' (global) or 'USER' (session-isolated).
 * @returns {*} The parsed JavaScript object/array, or null on cache miss.
 */
function getCache(key, scope = 'SCRIPT') {
  try {
    const cache = getCacheInstance_(scope);
    const raw = cache.get(key);

    if (raw === null) {
      logTelemetry_('CACHE_MISS', key);
      return null;
    }

    // Check if the retrieved item is a Shard Metadata Header
    if (raw.startsWith(CACHE_CONFIG.SHARD_PREFIX)) {
      const meta = JSON.parse(raw.substring(CACHE_CONFIG.SHARD_PREFIX.length));
      const chunkKeys = Array.from({ length: meta.chunks }, (_, i) => `${key}_chunk_${i}`);
      
      // Fetch all chunks in a single batch read
      const chunkMap = cache.getAll(chunkKeys);
      let reassembled = '';

      for (let i = 0; i < meta.chunks; i++) {
        const chunkData = chunkMap[`${key}_chunk_${i}`];
        if (!chunkData) {
          console.warn(`[CacheManager] Missing shard ${i} for key [${key}]. Declaring cache miss.`);
          logTelemetry_('CACHE_MISS_CORRUPTED_SHARD', key);
          return null;
        }
        reassembled += chunkData;
      }

      logTelemetry_('CACHE_HIT_SHARDED', key);
      return JSON.parse(reassembled);
    }

    logTelemetry_('CACHE_HIT', key);
    return JSON.parse(raw);

  } catch (err) {
    console.error(`[CacheManager] Read failure for key [${key}]: ${err.message}`);
    return null;
  }
}

/**
 * Serializes and stores a value in cache. Automatically splits payloads
 * exceeding 90 KB into sequential shards to bypass Apps Script limits.
 *
 * @param {string} key - Unique cache identifier.
 * @param {*} value - Data payload to cache (Array, Object, Primitive).
 * @param {number} [ttl=21600] - Time-to-live in seconds (max 21600).
 * @param {string} [scope='SCRIPT'] - 'SCRIPT' (global) or 'USER' (session-isolated).
 */
function setCache(key, value, ttl, scope = 'SCRIPT') {
  if (value === undefined || value === null) return;

  try {
    const cache = getCacheInstance_(scope);
    const effectiveTTL = Math.min(ttl || CACHE_CONFIG.DEFAULT_TTL, 21600);
    const serialized = JSON.stringify(value);

    // Case 1: Standard payload (fits within safe single-key limit)
    if (serialized.length <= CACHE_CONFIG.CHUNK_SIZE) {
      cache.put(key, serialized, effectiveTTL);
      return;
    }

    // Case 2: Heavy analytical payload -> Execute Sharding Strategy
    const totalChunks = Math.ceil(serialized.length / CACHE_CONFIG.CHUNK_SIZE);
    const chunkMap = {};

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CACHE_CONFIG.CHUNK_SIZE;
      const end = start + CACHE_CONFIG.CHUNK_SIZE;
      chunkMap[`${key}_chunk_${i}`] = serialized.substring(start, end);
    }

    // Store shard header metadata in the primary key
    const metaHeader = CACHE_CONFIG.SHARD_PREFIX + JSON.stringify({ chunks: totalChunks });
    cache.put(key, metaHeader, effectiveTTL);

    // Batch write all data shards simultaneously
    cache.putAll(chunkMap, effectiveTTL);
    console.info(`[CacheManager] Payload stored in ${totalChunks} shards for key [${key}].`);

  } catch (err) {
    console.error(`[CacheManager] Write failure for key [${key}]: ${err.message}`);
  }
}

/**
 * Removes a specific entry from the cache, including all sub-shards if applicable.
 *
 * @param {string} key - Cache identifier to purge.
 * @param {string} [scope='SCRIPT'] - 'SCRIPT' or 'USER'.
 */
function removeCache(key, scope = 'SCRIPT') {
  try {
    const cache = getCacheInstance_(scope);
    const raw = cache.get(key);

    const keysToRemove = [key];

    // If sharded, identify and purge all associated chunk keys
    if (raw && raw.startsWith(CACHE_CONFIG.SHARD_PREFIX)) {
      try {
        const meta = JSON.parse(raw.substring(CACHE_CONFIG.SHARD_PREFIX.length));
        for (let i = 0; i < meta.chunks; i++) {
          keysToRemove.push(`${key}_chunk_${i}`);
        }
      } catch (e) {
        console.warn(`[CacheManager] Could not parse shard meta during removal for [${key}]`);
      }
    }

    cache.removeAll(keysToRemove);

  } catch (err) {
    console.error(`[CacheManager] Eviction failure for key [${key}]: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. SPECIALIZED FINOPS & SCENARIO PURGING
// ---------------------------------------------------------------------------

/**
 * Enterprise Helper: Instantly invalidates all analytical cache layers associated
 * with a specific simulation scenario. Called immediately after applyOverrides().
 *
 * @param {string} scenarioId - Target scenario UUID to purge.
 * @param {string} [scope='SCRIPT'] - Target cache scope.
 */
function invalidateScenarioCache(scenarioId, scope = 'SCRIPT') {
  if (!scenarioId) return;

  try {
    const cache = getCacheInstance_(scope);
    
    // Taxonomic registry of cache key prefixes generated by DataService endpoints
    const queryPrefixes = [
      `CAGR_${scenarioId}`,
      `YOY_${scenarioId}`,
      `WATERFALL_${scenarioId}`,
      `SCATTER_${scenarioId}`,
      `PL_BASE_${scenarioId}`,
      `PL_DETAIL_${scenarioId}`
    ];

    // In a production environment, we purge known multi-year combinations
    // For extreme thoroughness, we map recent reporting years
    const currentYear = new Date().getFullYear();
    const keysToPurge = [];

    queryPrefixes.forEach(prefix => {
      keysToPurge.push(prefix);
      for (let y = currentYear - 2; y <= currentYear + 5; y++) {
        keysToPurge.push(`${prefix}_${y}`);
        keysToPurge.push(`${prefix}_${y}_ALL`);
      }
    });

    cache.removeAll(keysToPurge);
    console.info(`[CacheManager] Successfully purged ${keysToPurge.length} potential cache keys for scenario [${scenarioId}].`);

  } catch (err) {
    console.error(`[CacheManager] Scenario invalidation failed for [${scenarioId}]: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 4. PRIVATE HELPER METHODS
// ---------------------------------------------------------------------------

/**
 * Resolves the appropriate Apps Script Cache instance based on requested scope.
 * @private
 */
function getCacheInstance_(scope) {
  switch (scope.toUpperCase()) {
    case 'USER':
      return CacheService.getUserCache();
    case 'DOCUMENT':
      return CacheService.getDocumentCache();
    case 'SCRIPT':
    default:
      return CacheService.getScriptCache();
  }
}

/**
 * Safe telemetry dispatch that avoids throwing errors during cache operations.
 * @private
 */
function logTelemetry_(event, key) {
  try {
    if (typeof TelemetryService !== 'undefined') {
      TelemetryService.logEvent(event, { cacheKey: key });
    }
  } catch (e) {
    // Fail silently to prevent observability bugs from halting execution
  }
}