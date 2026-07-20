/**
 * =============================================================================
 * COST SIMULATION ENGINE – MAIN ORCHESTRATOR
 * Repository: cost-simulation-engine
 * Architecture: Serverless Hybrid Router (HTML Views + JSON API)
 * Description: Central entry point for the Enterprise FinOps Engine.
 *              Handles UI rendering, API routing, authentication, and telemetry.
 * Runtime: Google Apps Script (V8 Engine)
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// 1. GLOBAL CONFIGURATION & CONSTANTS
// ---------------------------------------------------------------------------
const CONFIG = {
  PROJECT_ID: 'YOUR_PROJECT_ID',
  DATASET: 'YOUR_DATASET',
  CACHE_TTL: 21600, // 6 hours in seconds (GAS architectural maximum)
  MAX_RETRIES: 3,
  DEFAULT_VIEW: 'Dashboard',
  ALLOWED_PAGES: ['Dashboard', 'Simulator', 'DetailedDRE'],
  ALLOWED_ACTIONS: [
    'getExecutiveDashboard',
    'getSimulationBaseline',
    'getDetailedDRE',
    'saveScenario',
    'askVIA'
  ]
};

// ---------------------------------------------------------------------------
// 2. ENTRY POINTS (HTTP GET & POST)
// ---------------------------------------------------------------------------

/**
 * Handles GET requests. Operates as a Hybrid Router:
 * - If 'action' param is present: Routes to JSON API endpoints.
 * - If 'page' param is present (or empty): Serves the corresponding HTML View.
 * 
 * @param {Object} e Event object with query parameters.
 * @returns {GoogleAppsScript.Content.TextOutput|GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  const params = e.parameter || {};

  // 1. API Routing Mode (Client-side asynchronous fetches)
  if (params.action) {
    return handleApiRequest(e, 'GET');
  }

  // 2. UI Rendering Mode (Browser navigation)
  const requestedPage = params.page || CONFIG.DEFAULT_VIEW;
  const targetView = CONFIG.ALLOWED_PAGES.includes(requestedPage) ? requestedPage : CONFIG.DEFAULT_VIEW;

  try {
    const template = HtmlService.createTemplateFromFile(targetView);
    // Inject server-side context variables into HTML views if necessary
    template.currentView = targetView;
    
    return template.evaluate()
      .setTitle(`Cost Simulation Engine | ${targetView}`)
      .setFaviconUrl('https://www.google.com/images/icons/product/analytics-32.png')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch (err) {
    if (typeof TelemetryService !== 'undefined') {
      TelemetryService.logError('UI_RENDER_FAILURE', err.message, { page: targetView });
    }
    return HtmlService.createHtmlOutput(`<h2>System Error: Unable to render view [${targetView}].</h2><p>${err.message}</p>`);
  }
}

/**
 * Handles all POST requests (scenario saving, V.I.A. natural language prompts).
 * @param {Object} e Event object with POST body.
 * @returns {GoogleAppsScript.Content.TextOutput} JSON response.
 */
function doPost(e) {
  return handleApiRequest(e, 'POST');
}

/**
 * Utility function exposed to HTML files to cleanly modularize includes (e.g., Styles.html).
 * @param {string} filename Name of the file to embed.
 * @returns {string} Raw file content.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------------------
// 3. CENTRALIZED API REQUEST HANDLER
// ---------------------------------------------------------------------------
function handleApiRequest(e, method) {
  const startTime = Date.now();
  const action = e.parameter.action;
  let userEmail = 'ANONYMOUS_SESSION';

  try {
    // Session Auth Resolution (Fallback structure for Workspace vs. Gmail deployments)
    const activeUser = Session.getActiveUser().getEmail();
    const effectiveUser = Session.getEffectiveUser().getEmail();
    userEmail = activeUser || effectiveUser || 'ANONYMOUS_SESSION';

    if (!action || !CONFIG.ALLOWED_ACTIONS.includes(action)) {
      return buildErrorResponse(400, `Invalid or missing action parameter: [${action}].`);
    }

    // Telemetry Audit Logging (Action initiation)
    if (typeof TelemetryService !== 'undefined') {
      TelemetryService.logEvent('API_REQUEST_START', { action: action, user: userEmail, method: method });
    }

    // Route to business logic handlers
    let responseData;
    switch (action) {
      case 'getExecutiveDashboard':
        responseData = getExecutiveDashboard(e.parameter);
        break;
      case 'getSimulationBaseline':
        responseData = getSimulationBaseline(e.parameter);
        break;
      case 'getDetailedDRE':
        responseData = getDetailedDRE(e.parameter);
        break;
      case 'saveScenario':
        responseData = handleSaveScenario(e, userEmail);
        break;
      case 'askVIA':
        responseData = handleAskVIA(e, userEmail);
        break;
      default:
        return buildErrorResponse(501, 'Action recognized but not implemented.');
    }

    // Log performance metrics upon success
    if (typeof TelemetryService !== 'undefined') {
      TelemetryService.logPerformance(action, Date.now() - startTime, { status: 'SUCCESS' });
    }

    return buildSuccessResponse(responseData);

  } catch (err) {
    // Enterprise Telemetry Integration & Centralized Error Logging
    console.error(`[Main.gs] Unhandled Exception in [${action}]: ${err.message}`, err.stack);
    
    if (typeof TelemetryService !== 'undefined') {
      TelemetryService.logError('API_EXECUTION_ERROR', err.message, { 
        action: action, 
        user: userEmail, 
        stack: err.stack,
        duration_ms: Date.now() - startTime 
      });
    }

    return buildErrorResponse(500, 'Internal FinOps Engine error. Telemetry has been dispatched.');
  }
}

// ---------------------------------------------------------------------------
// 4. BUSINESS LOGIC HANDLERS
// ---------------------------------------------------------------------------

/**
 * Fetches aggregated KPIs, CAGR, YoY table, waterfall, and scatter data.
 * Leverages server-level CacheManager to optimize BigQuery scan costs.
 */
function getExecutiveDashboard(params) {
  const cacheKey = `dashboard_${params.scenario_id || 'base'}_${params.current_year || '2026'}`;
  
  if (typeof CacheManager !== 'undefined') {
    const cached = CacheManager.getCache(cacheKey);
    if (cached) return cached;
  }
  
  // Safe invocation of DataService methods with fallback structures
  const data = {
    cards: DataService.getCAGRCards(params.scenario_id, params.start_year, params.end_year),
    summaryTable: DataService.getYoYSummary(params.scenario_id, params.current_year),
    waterfall: DataService.getWaterfall(params.scenario_id, params.start_year, params.end_year),
    scatter: DataService.getScatter(params.scenario_id, params.current_year),
    map: DataService.getMapData(params.scenario_id, params.current_year)
  };
  
  if (typeof CacheManager !== 'undefined') {
    CacheManager.setCache(cacheKey, data, CONFIG.CACHE_TTL);
  }
  
  return data;
}

/**
 * Fetches the raw P&L hierarchy for a specific POS or network aggregate.
 * Cascade simulation logic is executed client-side for zero-latency UX.
 */
function getSimulationBaseline(params) {
  const posId = params.pos_id || null; // null represents Full Network Aggregate
  const scenarioId = params.scenario_id || 'BASELINE_GAAP';
  const year = params.year || '2026';
  
  return DataService.getPLLineItems(scenarioId, year, posId);
}

/**
 * Fetches detailed P&L with granular line-item breakdowns.
 */
function getDetailedDRE(params) {
  const posId = params.pos_id || null;
  const scenarioId = params.scenario_id || 'BASELINE_GAAP';
  const year = params.year || '2026';
  
  return DataService.getDetailedPL(scenarioId, year, posId);
}

/**
 * Saves a user-defined simulation scenario and applies driver overrides.
 * Includes defensive JSON parsing to protect against malformed payloads.
 */
function handleSaveScenario(e, userEmail) {
  if (!e.postData || !e.postData.contents) {
    return buildErrorResponse(400, 'Missing POST body payload.');
  }
  
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (parseError) {
    return buildErrorResponse(400, 'Malformed JSON payload in request body.');
  }

  const scenarioName = payload.scenario_name;
  const baseline = payload.baseline_scenario_id || 'BASELINE_GAAP';
  const overrides = payload.overrides; // Array of {pos_id, driver_id, new_value}
  
  if (!scenarioName || !overrides || !Array.isArray(overrides)) {
    return buildErrorResponse(400, 'Missing or invalid required fields: [scenario_name, overrides].');
  }
  
  const newScenarioId = DataService.createScenario(scenarioName, userEmail, baseline);
  DataService.applyOverrides(newScenarioId, overrides);
  
  return { created_scenario_id: newScenarioId, status: 'PERSISTED_TO_BIGQUERY' };
}

/**
 * Forwards a natural language prompt to the V.I.A. (Virtual Interactive Analyst) agent.
 */
function handleAskVIA(e, userEmail) {
  if (!e.postData || !e.postData.contents) {
    return buildErrorResponse(400, 'Missing POST body payload.');
  }
  
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (parseError) {
    return buildErrorResponse(400, 'Malformed JSON payload in request body.');
  }

  const question = payload.question;
  const context = payload.context || {}; // {tab, filters, selected_pos}
  
  if (!question) {
    return buildErrorResponse(400, 'Missing required field: [question].');
  }
  
  if (typeof VIA_Agent === 'undefined') {
    return buildErrorResponse(503, 'V.I.A. AI Agent service is currently unavailable.');
  }

  const answer = VIA_Agent.ask(question, context, userEmail);
  return { answer: answer, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// 5. RESPONSE FACTORIES (JSON Normalization)
// ---------------------------------------------------------------------------
function buildSuccessResponse(data) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'success',
    timestamp: new Date().toISOString(),
    data: data
  }))
  .setMimeType(ContentService.MimeType.JSON);
}

function buildErrorResponse(code, message) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'error',
    code: code,
    timestamp: new Date().toISOString(),
    message: message
  }))
  .setMimeType(ContentService.MimeType.JSON);
}